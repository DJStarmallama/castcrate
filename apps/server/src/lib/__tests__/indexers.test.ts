import { describe, it, expect, vi } from "vitest";
import type { TorrentResult } from "@castcrate/shared";
import {
  runFallback,
  triedNames,
  type AdapterOutcome,
  type IndexerAdapter,
} from "../indexers.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fakeResult(source: TorrentResult["source"], title = "x"): TorrentResult {
  return {
    title,
    magnet: "",
    size: "0 B",
    sizeBytes: 0,
    seeds: 0,
    peers: 0,
    resolution: "unknown",
    videoCodec: "unknown",
    source,
    castFriendly: false,
  };
}

function adapter(overrides: Partial<IndexerAdapter> & { name: string }): IndexerAdapter {
  return {
    supportsMovie: true,
    supportsEpisode: true,
    supportsSeasonPack: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// runFallback — core semantics preserved from the old inline fallback code
// in routes/torrents.ts. If any of these change, so does the wire behaviour
// the web client already depends on — verify carefully before editing.
// ---------------------------------------------------------------------------

describe("runFallback", () => {
  it("returns the first non-empty adapter's results and stops the chain", async () => {
    const first = vi.fn(async (): Promise<AdapterOutcome> => ({ results: [] }));
    const second = vi.fn(async (): Promise<AdapterOutcome> => ({
      results: [fakeResult("yts", "hit")],
    }));
    const third = vi.fn(async (): Promise<AdapterOutcome> => ({
      results: [fakeResult("knaben", "unreached")],
    }));

    const out = await runFallback(
      [
        adapter({ name: "first", searchMovie: first }),
        adapter({ name: "second", searchMovie: second }),
        adapter({ name: "third", searchMovie: third }),
      ],
      { title: "matrix" },
      "movie",
    );

    expect(out.winner).toBe("second");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.title).toBe("hit");
    expect(third).not.toHaveBeenCalled();
  });

  it("records tried entries in visit order with counts", async () => {
    const out = await runFallback(
      [
        adapter({
          name: "a",
          searchMovie: async () => ({ results: [] }),
        }),
        adapter({
          name: "b",
          searchMovie: async () => ({ results: [fakeResult("yts")] }),
        }),
      ],
      { title: "x" },
      "movie",
    );

    expect(out.tried.map((t) => t.name)).toEqual(["a", "b"]);
    expect(out.tried[0]!.count).toBe(0);
    expect(out.tried[1]!.count).toBe(1);
  });

  it("catches thrown adapters and continues the chain with `<name>: <msg>` error", async () => {
    const out = await runFallback(
      [
        adapter({
          name: "boom",
          searchMovie: async () => {
            throw new Error("network down");
          },
        }),
        adapter({
          name: "ok",
          searchMovie: async () => ({ results: [fakeResult("yts", "ok")] }),
        }),
      ],
      { title: "x" },
      "movie",
    );

    expect(out.winner).toBe("ok");
    expect(out.errors).toEqual(["boom: network down"]);
    expect(out.tried[0]!.error).toBe("boom: network down");
  });

  it("uses adapter.formatThrown when present to produce structured errors", async () => {
    class AuthError extends Error {}
    const out = await runFallback(
      [
        adapter({
          name: "td",
          searchMovie: async () => {
            throw new AuthError();
          },
          formatThrown: (err) => {
            if (err instanceof AuthError) return { source: "td", code: "auth" };
            return undefined;
          },
        }),
      ],
      { title: "x" },
      "movie",
    );

    expect(out.errors).toEqual([{ source: "td", code: "auth" }]);
  });

  it("skips adapters whose `enabled()` gate returns false — no tried entry", async () => {
    const searchMovie = vi.fn();
    const out = await runFallback(
      [
        adapter({
          name: "disabled",
          enabled: () => false,
          searchMovie,
        }),
        adapter({
          name: "enabled",
          searchMovie: async () => ({ results: [fakeResult("yts")] }),
        }),
      ],
      { title: "x" },
      "movie",
    );

    expect(searchMovie).not.toHaveBeenCalled();
    expect(out.tried.map((t) => t.name)).toEqual(["enabled"]);
  });

  it("skips adapters that don't support the kind", async () => {
    const out = await runFallback(
      [
        adapter({
          name: "movie-only",
          supportsEpisode: false,
          searchMovie: async () => ({ results: [fakeResult("yts")] }),
        }),
        adapter({
          name: "episode-only",
          supportsMovie: false,
          searchEpisode: async () => ({ results: [fakeResult("eztv")] }),
        }),
      ],
      { imdbId: "tt1", season: 1, episode: 1 },
      "episode",
    );

    expect(out.winner).toBe("episode-only");
    expect(out.tried.map((t) => t.name)).toEqual(["episode-only"]);
  });

  it("expands partial-fanout errors into per-upstream error entries", async () => {
    // Mirrors how the Stremio adapter surfaces per-addon failures alongside
    // partial results — each addon error becomes its own entry in errors[].
    const out = await runFallback(
      [
        adapter({
          name: "stremio",
          searchMovie: async () => ({
            results: [],
            errors: [
              { addonId: "a1", addonName: "Torrentio", code: "fetch" },
              { addonId: "a2", addonName: "Other", code: "timeout" },
            ],
          }),
        }),
      ],
      { title: "x" },
      "movie",
    );

    expect(out.errors).toEqual([
      { source: "stremio", addonId: "a1", addonName: "Torrentio", code: "fetch" },
      { source: "stremio", addonId: "a2", addonName: "Other", code: "timeout" },
    ]);
  });

  it("returns empty results + tried + errors when the whole chain fails", async () => {
    const out = await runFallback(
      [
        adapter({
          name: "a",
          searchMovie: async () => {
            throw new Error("nope");
          },
        }),
        adapter({
          name: "b",
          searchMovie: async () => ({ results: [] }),
        }),
      ],
      { title: "x" },
      "movie",
    );

    expect(out.results).toEqual([]);
    expect(out.tried.map((t) => t.name)).toEqual(["a", "b"]);
    expect(out.errors).toEqual(["a: nope"]);
    expect(out.winner).toBeUndefined();
  });
});

describe("triedNames", () => {
  it("dedupes by name while preserving first-seen order", () => {
    const names = triedNames([
      { name: "a", count: 0 },
      { name: "b", count: 1 },
      { name: "a", count: 2 }, // dupe from second chain
      { name: "c", count: 0 },
    ]);
    expect(names).toEqual(["a", "b", "c"]);
  });
});
