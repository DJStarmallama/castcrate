/**
 * library.ts — atomic manifest CRUD + mutex + dedupe tests.
 *
 * Mirrors the history.test.ts pattern: redirect ~/.castcrate to a tmpdir via
 * mocking `node:os#homedir`, then import the service so its module-level
 * constants pick up the tmp path. Each test resets the in-memory cache and
 * clears the on-disk file so state doesn't bleed between assertions.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddToQueueRequest } from "@castcrate/shared";

const TMP = mkdtempSync(join(tmpdir(), "castcrate-library-"));

vi.mock("node:os", async () => {
  const real = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...real, homedir: () => TMP };
});

const {
  addToQueue,
  findByHash,
  findById,
  findByMagnet,
  listLibrary,
  markCompleted,
  markDownloading,
  remove,
  setPinned,
  __resetLibraryCacheForTests,
} = await import("../library.js");

const LIBRARY_PATH = join(TMP, ".castcrate", "library.json");

async function resetOnDisk(): Promise<void> {
  __resetLibraryCacheForTests();
  await rm(LIBRARY_PATH, { force: true });
  await rm(`${LIBRARY_PATH}.tmp`, { force: true });
}

const sampleReq = (
  overrides: Partial<AddToQueueRequest & { title: string }> = {},
): AddToQueueRequest => ({
  magnet:
    overrides.magnet ??
    "magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=Test",
  metadata: {
    title: overrides.title ?? "Test Movie",
    year: 2020,
    poster: null,
    imdbId: null,
    source: "yts",
    ...(overrides.metadata ?? {}),
  },
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetOnDisk();
});

describe("library — basic CRUD", () => {
  it("starts empty", async () => {
    const list = await listLibrary();
    expect(list).toEqual({ queued: [], downloading: [], completed: [] });
  });

  it("addToQueue appends a new entry, sets defaults", async () => {
    const { id, alreadyPresent } = await addToQueue(sampleReq());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(alreadyPresent).toBe(false);
    // Section = downloading because a valid btih hash was extracted from the
    // magnet (completedAt=null + hash!=null → downloading per the section
    // rules). "Queued" is reserved for items whose hash hasn't resolved yet
    // (e.g. hash-less magnets or pre-metadata items).
    const list = await listLibrary();
    expect(list.downloading).toHaveLength(1);
    const item = list.downloading[0]!;
    expect(item).toMatchObject({
      title: "Test Movie",
      year: 2020,
      completedAt: null,
      filePath: null,
      pinned: false,
      source: "yts",
    });
    // Hash was extracted from the magnet (lowercase, 40-char hex).
    expect(item.hash).toBe("a".repeat(40));
    // addedAt is a valid ISO-8601 timestamp.
    expect(new Date(item.addedAt).toISOString()).toBe(item.addedAt);
  });

  it("addToQueue is idempotent by hash — second identical add returns alreadyPresent:true", async () => {
    const first = await addToQueue(sampleReq());
    const second = await addToQueue(sampleReq());
    expect(second.id).toBe(first.id);
    expect(second.alreadyPresent).toBe(true);
    const list = await listLibrary();
    expect(list.downloading).toHaveLength(1);
  });

  it("addToQueue with a different magnet + hash creates a distinct entry", async () => {
    const a = await addToQueue(sampleReq({ magnet: "magnet:?xt=urn:btih:" + "b".repeat(40) }));
    const b = await addToQueue(sampleReq({ magnet: "magnet:?xt=urn:btih:" + "c".repeat(40) }));
    expect(a.id).not.toBe(b.id);
    const list = await listLibrary();
    expect(list.downloading).toHaveLength(2);
  });

  it("addToQueue with hash-less magnet dedupes by exact magnet string", async () => {
    // No xt=urn:btih: param → hash extraction fails → dedupe falls back to
    // exact magnet string match.
    const noHashMagnet = "magnet:?xt=urn:sha1:whatever&dn=NoBtih";
    const first = await addToQueue({
      magnet: noHashMagnet,
      metadata: {
        title: "NoBtih",
        year: null,
        poster: null,
        imdbId: null,
        source: "unknown",
      },
    });
    const second = await addToQueue({
      magnet: noHashMagnet,
      metadata: {
        title: "NoBtih",
        year: null,
        poster: null,
        imdbId: null,
        source: "unknown",
      },
    });
    expect(second.id).toBe(first.id);
    expect(second.alreadyPresent).toBe(true);
  });

  it("findById / findByHash / findByMagnet resolve after add", async () => {
    const { id } = await addToQueue(sampleReq());
    const byId = await findById(id);
    expect(byId?.id).toBe(id);
    const byHash = await findByHash("a".repeat(40));
    expect(byHash?.id).toBe(id);
    const byMagnet = await findByMagnet(sampleReq().magnet);
    expect(byMagnet?.id).toBe(id);
    expect(await findById("nope")).toBeNull();
    expect(await findByHash("f".repeat(40))).toBeNull();
    expect(await findByMagnet("magnet:?xt=urn:btih:" + "e".repeat(40))).toBeNull();
  });
});

describe("library — state transitions", () => {
  it("markDownloading sets hash without setting completedAt", async () => {
    // Use a hash-less magnet so we can observe the transition.
    const req: AddToQueueRequest = {
      magnet: "magnet:?xt=urn:sha1:nohash",
      metadata: {
        title: "T",
        year: null,
        poster: null,
        imdbId: null,
        source: "unknown",
      },
    };
    const { id } = await addToQueue(req);
    // Before: queued (hash is null since we couldn't extract from magnet).
    let list = await listLibrary();
    expect(list.queued).toHaveLength(1);
    expect(list.downloading).toHaveLength(0);
    // After markDownloading: moves to downloading bucket.
    await markDownloading(id, "d".repeat(40));
    list = await listLibrary();
    expect(list.queued).toHaveLength(0);
    expect(list.downloading).toHaveLength(1);
    expect(list.downloading[0]!.hash).toBe("d".repeat(40));
    expect(list.downloading[0]!.completedAt).toBeNull();
  });

  it("markCompleted sets completedAt + filePath and item lands in completed bucket", async () => {
    const { id } = await addToQueue(sampleReq());
    await markCompleted(id, "/abs/path/to/movie.mkv");
    const list = await listLibrary();
    expect(list.queued).toHaveLength(0);
    expect(list.completed).toHaveLength(1);
    const item = list.completed[0]!;
    expect(item.filePath).toBe("/abs/path/to/movie.mkv");
    expect(item.completedAt).not.toBeNull();
    expect(new Date(item.completedAt!).toISOString()).toBe(item.completedAt);
  });

  it("setPinned toggles the pinned flag; findById reflects it", async () => {
    const { id } = await addToQueue(sampleReq());
    await setPinned(id, true);
    expect((await findById(id))?.pinned).toBe(true);
    await setPinned(id, false);
    expect((await findById(id))?.pinned).toBe(false);
  });

  it("remove returns the removed item and drops it from the manifest", async () => {
    const { id } = await addToQueue(sampleReq());
    const { item } = await remove(id);
    expect(item?.id).toBe(id);
    const list = await listLibrary();
    expect(list.queued).toHaveLength(0);
    // Idempotent-friendly: second remove returns null.
    const again = await remove(id);
    expect(again.item).toBeNull();
  });

  it("listLibrary sorts each section by addedAt desc", async () => {
    const a = await addToQueue(sampleReq({ magnet: "magnet:?xt=urn:btih:" + "a".repeat(40), title: "A" }));
    // Bump the clock a millisecond to guarantee a distinct ISO timestamp.
    await new Promise((r) => setTimeout(r, 5));
    const b = await addToQueue(sampleReq({ magnet: "magnet:?xt=urn:btih:" + "b".repeat(40), title: "B" }));
    const list = await listLibrary();
    // Both have a resolvable hash → downloading section. Newer (b) first.
    expect(list.downloading.map((i) => i.id)).toEqual([b.id, a.id]);
  });
});

describe("library — atomic write + mutex", () => {
  it("atomic write leaves no .tmp behind on success", async () => {
    const { existsSync } = await import("node:fs");
    await addToQueue(sampleReq());
    expect(existsSync(LIBRARY_PATH)).toBe(true);
    expect(existsSync(`${LIBRARY_PATH}.tmp`)).toBe(false);
  });

  it("concurrent addToQueue for two distinct magnets: both entries land, no lost write", async () => {
    // Two concurrent calls — the mutex must serialize the read-modify-write
    // cycles so neither clobbers the other. Without the mutex, both would
    // load an empty cache in parallel, each append a single entry, and the
    // last write would overwrite the other's addition.
    const [a, b] = await Promise.all([
      addToQueue(sampleReq({ magnet: "magnet:?xt=urn:btih:" + "1".repeat(40), title: "One" })),
      addToQueue(sampleReq({ magnet: "magnet:?xt=urn:btih:" + "2".repeat(40), title: "Two" })),
    ]);
    expect(a.id).not.toBe(b.id);
    // Force a fresh disk read to prove the mutex serialized the writes AND
    // both landed on disk (not just in the in-process cache).
    __resetLibraryCacheForTests();
    const list = await listLibrary();
    expect(list.downloading).toHaveLength(2);
    const ids = list.downloading.map((i) => i.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("concurrent add + markCompleted: both mutations end up on disk", async () => {
    const first = await addToQueue(sampleReq({ magnet: "magnet:?xt=urn:btih:" + "3".repeat(40), title: "First" }));
    // Race a fresh add against a markCompleted on the existing entry.
    await Promise.all([
      addToQueue(sampleReq({ magnet: "magnet:?xt=urn:btih:" + "4".repeat(40), title: "Second" })),
      markCompleted(first.id, "/abs/first.mkv"),
    ]);
    __resetLibraryCacheForTests();
    const list = await listLibrary();
    expect(list.downloading).toHaveLength(1);
    expect(list.completed).toHaveLength(1);
    expect(list.completed[0]!.id).toBe(first.id);
    expect(list.completed[0]!.filePath).toBe("/abs/first.mkv");
  });
});

describe("library — corruption recovery", () => {
  it("corrupt manifest falls back to empty list; subsequent add succeeds", async () => {
    // Write garbage directly to the manifest, THEN reset the cache so the
    // next load() re-reads from disk. Suppress the expected warn spam.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(TMP, ".castcrate"), { recursive: true });
    await writeFile(LIBRARY_PATH, "{not valid json", "utf8");
    __resetLibraryCacheForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const list = await listLibrary();
      expect(list).toEqual({ queued: [], downloading: [], completed: [] });
      const { id, alreadyPresent } = await addToQueue(sampleReq());
      expect(alreadyPresent).toBe(false);
      expect((await findById(id))?.id).toBe(id);
    } finally {
      warn.mockRestore();
    }
  });

  it("non-array manifest (e.g. {}) also falls back to empty list", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(TMP, ".castcrate"), { recursive: true });
    await writeFile(LIBRARY_PATH, '{"not":"an array"}', "utf8");
    __resetLibraryCacheForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const list = await listLibrary();
      expect(list.queued).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
