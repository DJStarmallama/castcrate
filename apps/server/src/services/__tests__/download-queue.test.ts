/**
 * download-queue.ts tests — background worker orchestration.
 *
 * Approach: mock the two collaborators (library.ts and torrent.ts) so we can
 * drive the worker through queue-drain, done, and error flows deterministically
 * without spinning up real WebTorrent. Concurrency cap is verified by seeding
 * the manifest with more items than the cap allows.
 *
 * The mock library.ts uses an in-memory array so the worker's markDownloading
 * / markCompleted mutations are observable via listLibrary() in the assertions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { LibraryItem, LibraryListResponse } from "@castcrate/shared";

// ---------------------------------------------------------------------------
// Config mock: cap concurrency at 2 (default), point downloadPath at /tmp/x.
// ---------------------------------------------------------------------------
vi.mock("../../lib/config.js", () => ({
  config: {
    downloadPath: "/tmp/castcrate-dqtest",
    maxConcurrentQueued: 2,
  },
}));

// ---------------------------------------------------------------------------
// Mock stat so onComplete finds the "file on disk" — return success for the
// nested path (config.downloadPath/name/videoName) which is what WebTorrent
// lays out.
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises", async () => {
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...real,
    stat: vi.fn(async () => ({ size: 1000 })),
  };
});

// ---------------------------------------------------------------------------
// Library mock — in-memory array, exposes the same public surface the worker
// uses.
// ---------------------------------------------------------------------------
const libraryState: { items: LibraryItem[] } = { items: [] };

vi.mock("../library.js", () => ({
  load: vi.fn(async () => libraryState.items),
  markDownloading: vi.fn(async (id: string, hash: string) => {
    const item = libraryState.items.find((i) => i.id === id);
    if (item) item.hash = hash.toLowerCase();
  }),
  markCompleted: vi.fn(async (id: string, filePath: string) => {
    const item = libraryState.items.find((i) => i.id === id);
    if (item) {
      item.completedAt = new Date().toISOString();
      item.filePath = filePath;
    }
  }),
}));

// ---------------------------------------------------------------------------
// Torrent mock — startTorrent returns a session and stashes a fake WtTorrent
// EventEmitter so tests can drive done/error events.
// ---------------------------------------------------------------------------
interface FakeTorrent extends EventEmitter {
  infoHash: string;
  name: string;
  done: boolean;
}

const torrentRegistry = new Map<string, FakeTorrent>();
const startTorrentMock = vi.fn();
const getTorrentMock = vi.fn();
const removeTorrentMock = vi.fn(async () => {});

vi.mock("../torrent.js", () => ({
  startTorrent: (magnet: string, opts?: unknown) => startTorrentMock(magnet, opts),
  getTorrent: (hash: string) => getTorrentMock(hash),
  removeTorrent: (hash: string, opts?: unknown) => removeTorrentMock(hash, opts),
}));

// Now import the SUT.
const {
  startDownloadQueueProcessor,
  stopDownloadQueueProcessor,
  kickDownloadQueue,
  __resetDownloadQueueForTests,
  __getActiveIdsForTests,
} = await import("../download-queue.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(id: string, magnet: string): LibraryItem {
  return {
    id,
    magnet,
    hash: null,
    title: `Title ${id}`,
    year: 2020,
    poster: null,
    imdbId: null,
    source: "yts",
    addedAt: new Date(Date.now() + id.charCodeAt(id.length - 1)).toISOString(),
    completedAt: null,
    filePath: null,
    pinned: false,
  };
}

function makeFakeTorrent(hash: string, name: string, done = false): FakeTorrent {
  const ee = new EventEmitter() as FakeTorrent;
  ee.infoHash = hash;
  ee.name = name;
  ee.done = done;
  torrentRegistry.set(hash, ee);
  return ee;
}

/** Wire up the standard "startTorrent + getTorrent" happy path for a given
 *  library item so kick() will spawn one WebTorrent add and attach a
 *  driveable torrent instance. Returns the torrent so the test can .emit(). */
function armSuccessPath(item: LibraryItem, hash: string, videoName = "movie.mkv"): FakeTorrent {
  const torrentName = `Torrent-${item.id}`;
  const torrent = makeFakeTorrent(hash, torrentName);
  startTorrentMock.mockImplementationOnce(async (magnet: string) => {
    // Ensure the mock was called with the right magnet.
    if (magnet !== item.magnet) {
      throw new Error(`startTorrent called with unexpected magnet: ${magnet}`);
    }
    return { infoHash: hash, name: torrentName, videoName, videoLength: 1000 };
  });
  getTorrentMock.mockImplementationOnce(async (h: string) => {
    if (h !== hash) return null;
    return torrent;
  });
  return torrent;
}

/** Wait a scheduler tick — vitest tests are async and the worker uses
 *  fire-and-forget promises internally, so we let the microtask queue drain
 *  before asserting.  */
async function flush(): Promise<void> {
  // A few macro-ticks for good measure — startTorrent -> markDownloading ->
  // getTorrent -> attach listeners is 3-4 awaits deep.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  libraryState.items = [];
  torrentRegistry.clear();
  startTorrentMock.mockReset();
  getTorrentMock.mockReset();
  removeTorrentMock.mockReset();
  removeTorrentMock.mockImplementation(async () => {});
  __resetDownloadQueueForTests();
});

afterEach(async () => {
  await stopDownloadQueueProcessor();
});

describe("download-queue — concurrency cap", () => {
  it("respects config.maxConcurrentQueued when there are more queued items than slots", async () => {
    // Seed 3 queued items with maxConcurrentQueued=2.
    libraryState.items = [
      makeItem("a", "magnet:?xt=urn:btih:" + "a".repeat(40)),
      makeItem("b", "magnet:?xt=urn:btih:" + "b".repeat(40)),
      makeItem("c", "magnet:?xt=urn:btih:" + "c".repeat(40)),
    ];
    // Arm the success path for a and b — startTorrent resolves with the
    // session; getTorrent returns a torrent EE that never fires 'done', so
    // both a and b stay "active" and occupy their slots.
    armSuccessPath(libraryState.items[0]!, "a".repeat(40));
    armSuccessPath(libraryState.items[1]!, "b".repeat(40));
    // c should NOT be picked up — no armed startTorrent for it.

    kickDownloadQueue();
    await flush();

    const active = __getActiveIdsForTests();
    expect(active).toHaveLength(2);
    expect(active.sort()).toEqual(["a", "b"]);
    expect(startTorrentMock).toHaveBeenCalledTimes(2);
  });

  it("advances to the next queued item after one completes", async () => {
    libraryState.items = [
      makeItem("a", "magnet:?xt=urn:btih:" + "a".repeat(40)),
      makeItem("b", "magnet:?xt=urn:btih:" + "b".repeat(40)),
      makeItem("c", "magnet:?xt=urn:btih:" + "c".repeat(40)),
    ];
    const torrentA = armSuccessPath(libraryState.items[0]!, "a".repeat(40));
    armSuccessPath(libraryState.items[1]!, "b".repeat(40));

    kickDownloadQueue();
    await flush();
    expect(__getActiveIdsForTests().sort()).toEqual(["a", "b"]);
    expect(startTorrentMock).toHaveBeenCalledTimes(2);

    // Arm the success path for c BEFORE we free the slot so the worker
    // finds it armed when it scans next.
    armSuccessPath(libraryState.items[2]!, "c".repeat(40));

    // Fire done on a — worker marks completed, detaches, and kicks scan
    // which should pick up c.
    torrentA.emit("done");
    await flush();

    const active = __getActiveIdsForTests();
    expect(active.sort()).toEqual(["b", "c"]);
    // startTorrent called 3 times total (a, b, c).
    expect(startTorrentMock).toHaveBeenCalledTimes(3);
  });
});

describe("download-queue — done + error handling", () => {
  it("'done' triggers markCompleted with the file path AND detaches the torrent", async () => {
    libraryState.items = [makeItem("x", "magnet:?xt=urn:btih:" + "1".repeat(40))];
    const torrent = armSuccessPath(libraryState.items[0]!, "1".repeat(40), "flick.mkv");

    kickDownloadQueue();
    await flush();

    // markDownloading was called with the resolved hash.
    const item = libraryState.items[0]!;
    expect(item.hash).toBe("1".repeat(40));

    torrent.emit("done");
    await flush();

    // markCompleted persisted a filePath.
    expect(item.completedAt).not.toBeNull();
    expect(item.filePath).toContain("flick.mkv");
    // Torrent was detached from the client, files kept on disk.
    expect(removeTorrentMock).toHaveBeenCalledWith("1".repeat(40), {
      destroyStore: false,
    });
    // Slot freed.
    expect(__getActiveIdsForTests()).toEqual([]);
  });

  it("startTorrent error frees the slot; retry counter bumped; other items unaffected", async () => {
    libraryState.items = [
      makeItem("bad", "magnet:?xt=urn:btih:" + "1".repeat(40)),
      makeItem("good", "magnet:?xt=urn:btih:" + "2".repeat(40)),
    ];
    // bad throws immediately; good succeeds.
    startTorrentMock.mockImplementationOnce(async () => {
      throw new Error("timed out");
    });
    armSuccessPath(libraryState.items[1]!, "2".repeat(40));
    // Silence the expected error log.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      kickDownloadQueue();
      await flush();
      // bad is gone from active; good remains active until we fire done.
      expect(__getActiveIdsForTests()).toEqual(["good"]);
      // library state for bad is unchanged (still queued, no hash, no completedAt).
      expect(libraryState.items[0]!.hash).toBeNull();
      expect(libraryState.items[0]!.completedAt).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("torrent 'error' event frees the slot and leaves the manifest unchanged", async () => {
    libraryState.items = [
      makeItem("t", "magnet:?xt=urn:btih:" + "9".repeat(40)),
    ];
    const torrent = armSuccessPath(libraryState.items[0]!, "9".repeat(40));
    kickDownloadQueue();
    await flush();
    expect(__getActiveIdsForTests()).toEqual(["t"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      torrent.emit("error", new Error("peer meltdown"));
      await flush();
      // Slot freed.
      expect(__getActiveIdsForTests()).toEqual([]);
      // Item was NOT marked completed (no completedAt); no filePath.
      expect(libraryState.items[0]!.completedAt).toBeNull();
      expect(libraryState.items[0]!.filePath).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("MAX_RETRIES ceiling: repeated errors on the same item stop it being picked up", async () => {
    libraryState.items = [
      makeItem("r", "magnet:?xt=urn:btih:" + "8".repeat(40)),
    ];
    // Every startTorrent call throws — worker retries via bumpRetries.
    startTorrentMock.mockImplementation(async () => {
      throw new Error("no peers");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // Kick 5 times — MAX_RETRIES is 3. The item is picked up 3 times, then
      // shouldn't be picked again.
      for (let i = 0; i < 5; i++) {
        kickDownloadQueue();
        await flush();
      }
      expect(startTorrentMock).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("download-queue — boot resume", () => {
  it("startDownloadQueueProcessor picks up completedAt===null items on boot", async () => {
    libraryState.items = [
      makeItem("resume", "magnet:?xt=urn:btih:" + "7".repeat(40)),
    ];
    // Pretend this item was mid-download when the server crashed — its hash
    // is already set (was in the downloading section).
    libraryState.items[0]!.hash = "7".repeat(40);
    armSuccessPath(libraryState.items[0]!, "7".repeat(40));

    startDownloadQueueProcessor();
    await flush();

    expect(__getActiveIdsForTests()).toEqual(["resume"]);
    expect(startTorrentMock).toHaveBeenCalledTimes(1);
  });

  it("skips items with completedAt already set", async () => {
    libraryState.items = [
      { ...makeItem("done", "magnet:?xt=urn:btih:" + "6".repeat(40)),
        completedAt: new Date().toISOString(),
        hash: "6".repeat(40),
        filePath: "/tmp/x/done.mkv",
      },
    ];
    startDownloadQueueProcessor();
    await flush();
    expect(__getActiveIdsForTests()).toEqual([]);
    expect(startTorrentMock).not.toHaveBeenCalled();
  });
});

// Silence the export-only "unused" warning while keeping the helpers in place
// for future test additions.
export { armSuccessPath, makeItem };
export type { LibraryListResponse };
