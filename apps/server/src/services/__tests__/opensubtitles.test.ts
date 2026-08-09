/**
 * OpenSubtitles adapter unit tests.
 *
 * The adapter is disabled at import time if OPENSUBTITLES_API_KEY is unset,
 * so each test manipulates process.env BEFORE the dynamic import (`beforeAll`
 * runs too late for module-scope reads of `config`). We use a small helper
 * that resets ES-module state via `vi.resetModules()` between test groups.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test writes cached SRT files somewhere — pin DOWNLOAD_PATH to a temp
// dir so we don't pollute the user's real downloads folder.
const tmpDownload = mkdtempSync(join(tmpdir(), "castcrate-os-test-"));
process.env.DOWNLOAD_PATH = tmpDownload;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// Cleanup once at end of file — mktmp before every test would be noisier and
// the module keeps an LRU cache we reset per describe block via resetModules.
process.on("exit", () => {
  try {
    rmSync(tmpDownload, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

interface FakeResponse {
  ok?: boolean;
  status?: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}

function mockFetchSequence(...responses: FakeResponse[]) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: r.json,
      text: r.text ?? (async () => ""),
    });
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Full search response shape (subset — only fields the adapter reads). */
function searchResponse(
  entries: Array<{
    file_id: number;
    language: string;
    release?: string;
    download_count?: number;
  }>,
) {
  return {
    data: entries.map((e) => ({
      id: String(e.file_id),
      type: "subtitle",
      attributes: {
        language: e.language,
        ...(e.release ? { release: e.release } : {}),
        ...(typeof e.download_count === "number"
          ? { download_count: e.download_count }
          : {}),
        files: [{ file_id: e.file_id, file_name: `sub-${e.file_id}.srt` }],
      },
    })),
  };
}

describe("searchOpenSubtitles — disabled (no API key)", () => {
  beforeEach(() => {
    delete process.env.OPENSUBTITLES_API_KEY;
  });

  it("returns [] when the API key is missing (no fetch call)", async () => {
    const { searchOpenSubtitles } = await import("../opensubtitles.js");
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    const res = await searchOpenSubtitles({ imdbId: "tt1234567" });
    expect(res).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("searchOpenSubtitles — happy path", () => {
  beforeEach(() => {
    process.env.OPENSUBTITLES_API_KEY = "test-key";
    process.env.OPENSUBTITLES_LANGUAGES = "en";
  });

  it("returns tracks from a valid response, sorted by download_count", async () => {
    const fn = mockFetchSequence({
      json: async () =>
        searchResponse([
          { file_id: 111, language: "en", release: "YIFY", download_count: 500 },
          {
            file_id: 222,
            language: "en",
            release: "BluRay.x265",
            download_count: 9000,
          },
        ]),
    });
    const { searchOpenSubtitles } = await import("../opensubtitles.js");
    const res = await searchOpenSubtitles({ imdbId: "tt1375666" });
    expect(res).toHaveLength(2);
    // Sorted desc — 9000 first.
    expect(res[0]?.fileId).toBe("222");
    expect(res[0]?.id).toBe("os:222");
    expect(res[0]?.language).toBe("en");
    expect(res[0]?.languageName).toBe("English");
    expect(res[0]?.releaseName).toBe("BluRay.x265");
    expect(res[0]?.downloadCount).toBe(9000);
    // Request went to the right URL with the imdb_id stripped of "tt".
    const [urlArg, initArg] = fn.mock.calls[0]!;
    const url = new URL(String(urlArg));
    expect(url.pathname).toContain("/api/v1/subtitles");
    expect(url.searchParams.get("imdb_id")).toBe("1375666");
    expect(url.searchParams.get("languages")).toBe("en");
    // API-Key and User-Agent headers must both be present (OS TOS).
    const headers = (initArg as { headers: Record<string, string> }).headers;
    expect(headers["Api-Key"]).toBe("test-key");
    expect(headers["User-Agent"]).toBe("CastCrate/1.0");
  });

  it("filters out languages not in the requested list", async () => {
    mockFetchSequence({
      json: async () =>
        searchResponse([
          { file_id: 111, language: "en", download_count: 100 },
          { file_id: 222, language: "es", download_count: 50 },
        ]),
    });
    const { searchOpenSubtitles } = await import("../opensubtitles.js");
    const res = await searchOpenSubtitles({
      imdbId: "tt1375666",
      languages: ["en"],
    });
    expect(res.map((r) => r.fileId)).toEqual(["111"]);
  });

  it("caches search results — second call does not hit fetch", async () => {
    const fn = mockFetchSequence({
      json: async () =>
        searchResponse([{ file_id: 1, language: "en", download_count: 1 }]),
    });
    const { searchOpenSubtitles } = await import("../opensubtitles.js");
    const first = await searchOpenSubtitles({ imdbId: "tt1000" });
    const second = await searchOpenSubtitles({ imdbId: "tt1000" });
    expect(first).toEqual(second);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns [] when both imdbId and query are missing", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    const { searchOpenSubtitles } = await import("../opensubtitles.js");
    const res = await searchOpenSubtitles({});
    expect(res).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("searchOpenSubtitles — error paths", () => {
  beforeEach(() => {
    process.env.OPENSUBTITLES_API_KEY = "test-key";
    process.env.OPENSUBTITLES_LANGUAGES = "en";
  });

  it("returns [] and logs on HTTP 500", async () => {
    mockFetchSequence({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { searchOpenSubtitles } = await import("../opensubtitles.js");
    const res = await searchOpenSubtitles({ imdbId: "tt404" });
    expect(res).toEqual([]);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("returns [] and logs on network error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fn);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { searchOpenSubtitles } = await import("../opensubtitles.js");
    const res = await searchOpenSubtitles({ imdbId: "tt404" });
    expect(res).toEqual([]);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("returns [] on 429 (rate limit) — caller falls back to torrent-only", async () => {
    mockFetchSequence({ ok: false, status: 429, json: async () => ({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { searchOpenSubtitles } = await import("../opensubtitles.js");
    const res = await searchOpenSubtitles({ imdbId: "tt429" });
    expect(res).toEqual([]);
    logSpy.mockRestore();
  });
});

describe("fetchOpenSubtitle — download caching", () => {
  beforeEach(() => {
    process.env.OPENSUBTITLES_API_KEY = "test-key";
  });

  it("throws when the adapter is disabled", async () => {
    delete process.env.OPENSUBTITLES_API_KEY;
    const { fetchOpenSubtitle } = await import("../opensubtitles.js");
    await expect(fetchOpenSubtitle("os:1")).rejects.toThrow(/not configured/i);
  });

  it("caches to disk — second call skips both fetches", async () => {
    // First call: POST /download → temp url; GET url → SRT body.
    // Second call: no fetches at all — file is on disk.
    const fn = mockFetchSequence(
      {
        json: async () => ({ link: "https://os-temp.example/file.srt" }),
      },
      {
        json: async () => ({}), // shouldn't be read on the body fetch
        text: async () => "1\n00:00:01,000 --> 00:00:02,000\nHello\n",
      },
    );
    const { fetchOpenSubtitle } = await import("../opensubtitles.js");
    // Use a unique file_id per test so runs don't collide via the shared temp
    // download dir carry-over from a previous vitest process.
    const uniqueId = String(Date.now() % 1_000_000);
    const first = await fetchOpenSubtitle(`os:${uniqueId}`);
    expect(first.srtPath.endsWith(`${uniqueId}.srt`)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    const second = await fetchOpenSubtitle(`os:${uniqueId}`);
    expect(second.srtPath).toBe(first.srtPath);
    // Second call: fetch count unchanged.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws when /download returns non-2xx (quota exceeded → 406)", async () => {
    mockFetchSequence({ ok: false, status: 406, json: async () => ({}) });
    const { fetchOpenSubtitle } = await import("../opensubtitles.js");
    await expect(
      fetchOpenSubtitle(`os:${Date.now()}9`),
    ).rejects.toThrow(/quota exceeded/i);
  });

  it("rejects an invalid file id", async () => {
    const { fetchOpenSubtitle } = await import("../opensubtitles.js");
    await expect(fetchOpenSubtitle("os:not-a-number")).rejects.toThrow(
      /invalid opensubtitles file id/i,
    );
  });
});
