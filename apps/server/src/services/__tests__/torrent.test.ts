/**
 * Idempotency contract for removeTorrent().
 *
 * webtorrent v2's `client.remove()` rejects with "No torrent with id ..."
 * on the returned promise when the torrent is already gone. That rejection
 * previously escaped as an unhandled promise rejection and crashed the
 * process on the second DELETE (e.g. UI double-click). removeTorrent()
 * swallows exactly that error string so the DELETE endpoint is safely
 * idempotent — verify that here with a mocked client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Track how many times remove() was invoked and what it was asked to do.
const removeCalls: Array<{ infoHash: string; opts?: { destroyStore?: boolean } }> = [];

// State for the mock: after the first remove() the torrent is "gone" and
// subsequent removals reject the way webtorrent v2 does.
let torrentPresent = true;

class MockClient {
  torrents: Array<{ infoHash: string }> = [];

  async remove(infoHash: string, opts?: { destroyStore?: boolean }): Promise<void> {
    removeCalls.push({ infoHash, opts });
    if (!torrentPresent) {
      throw new Error(`No torrent with id ${infoHash}`);
    }
    torrentPresent = false;
  }

  add(): void {
    // not used by this test
  }

  get(): null {
    return null;
  }

  // Crash-safety listener wired in getClient() — no-op mock is fine.
  on(_event: string, _cb: (err: Error) => void): void {}

  destroy(cb?: () => void): void {
    if (cb) cb();
  }
}

vi.mock("webtorrent", () => ({ default: MockClient }));

// Also mock node:fs so importing services/torrent.ts doesn't try to mkdir
// the real DOWNLOAD_PATH during the module's top-level side-effect.
vi.mock("node:fs", async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...real, mkdirSync: vi.fn() };
});

const { removeTorrent, setMeta, getMeta } = await import("../torrent.js");

beforeEach(() => {
  removeCalls.length = 0;
  torrentPresent = true;
});

describe("removeTorrent — idempotency", () => {
  it("second call does not throw (webtorrent v2 rejects with 'No torrent with id')", async () => {
    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    // First removal — expected to succeed.
    await expect(removeTorrent(hash)).resolves.toBeUndefined();
    // Second removal — webtorrent rejects, service must swallow.
    await expect(removeTorrent(hash)).resolves.toBeUndefined();
    // Both attempts must have reached the client.
    expect(removeCalls).toHaveLength(2);
    expect(removeCalls[0]?.infoHash).toBe(hash);
    expect(removeCalls[1]?.infoHash).toBe(hash);
  });

  it("clears the meta map on removal (first call)", async () => {
    const hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    setMeta(hash, {
      title: "Test",
      posterUrl: null,
      imdbId: null,
      resolution: null,
      videoCodec: null,
      startedAt: new Date().toISOString(),
    });
    expect(getMeta(hash)).toBeDefined();
    await removeTorrent(hash);
    expect(getMeta(hash)).toBeUndefined();
  });

  it("forwards destroyStore option to the client", async () => {
    const hash = "cccccccccccccccccccccccccccccccccccccccc";
    await removeTorrent(hash, { destroyStore: true });
    expect(removeCalls[0]?.opts?.destroyStore).toBe(true);
  });

  it("rethrows non-'No torrent with id' errors", async () => {
    const hash = "dddddddddddddddddddddddddddddddddddddddd";
    const origRemove = MockClient.prototype.remove;
    // Swap remove() out for one that rejects with an unrelated error — the
    // service must NOT swallow this one; only "No torrent with id ..." is
    // the idempotent-second-call signal.
    MockClient.prototype.remove = vi
      .fn()
      .mockRejectedValue(new Error("disk full"));
    try {
      await expect(removeTorrent(hash)).rejects.toThrow(/disk full/);
    } finally {
      MockClient.prototype.remove = origRemove;
    }
  });
});
