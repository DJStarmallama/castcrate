import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Module-level mocks — declared before the module is imported.
// ---------------------------------------------------------------------------

vi.mock("../settings.js", () => ({
  getSettings: vi.fn(),
}));

vi.mock("../../lib/proxy.js", () => ({
  getDispatcher: vi.fn(() => undefined),
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up.
// ---------------------------------------------------------------------------

import {
  normaliseAddonBase,
  validateAddon,
  searchStremioMovie,
  searchStremioEpisode,
  FALLBACK_TRACKERS,
  _clearCache,
  type StremioSearchOutcome,
} from "../stremio.js";
import { getSettings } from "../settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StremioAddon = {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
};

function mockSettings(addons: StremioAddon[] = []) {
  (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
    stremioAddons: addons,
    proxyUrl: null,
    proxyEnabled: {
      yts: false,
      eztv: false,
      knaben: false,
      torrentday: false,
      stremio: false,
    },
    bufferPercent: 3,
    transcodeBufferPercent: 5,
    transcodeBitrate: "5M",
    torrentDay: { enabled: false, uid: null, pass: null },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stremio adapter", () => {
  let manifestFixture: string;
  let manifestNoStreamFixture: string;
  let movieStreamsFixture: string;
  let manifestKitsuOnlyFixture: string;

  beforeEach(async () => {
    manifestFixture = await readFile(join(FIXTURES, "stremio-manifest.json"), "utf8");
    manifestNoStreamFixture = await readFile(join(FIXTURES, "stremio-manifest-no-stream.json"), "utf8");
    movieStreamsFixture = await readFile(join(FIXTURES, "stremio-movie-streams.json"), "utf8");
    manifestKitsuOnlyFixture = await readFile(join(FIXTURES, "stremio-manifest-kitsu-only.json"), "utf8");
    _clearCache();
    vi.unstubAllGlobals();
    mockSettings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // 1. normaliseAddonBase
  // -------------------------------------------------------------------------
  describe("normaliseAddonBase", () => {
    it("strips trailing /manifest.json", () => {
      expect(normaliseAddonBase("https://torrentio.strem.fun/manifest.json"))
        .toBe("https://torrentio.strem.fun");
    });

    it("strips trailing /manifest.json case-insensitively", () => {
      expect(normaliseAddonBase("https://torrentio.strem.fun/Manifest.JSON"))
        .toBe("https://torrentio.strem.fun");
    });

    it("strips trailing slash", () => {
      expect(normaliseAddonBase("https://torrentio.strem.fun/"))
        .toBe("https://torrentio.strem.fun");
    });

    it("strips /manifest.json before stripping trailing slash", () => {
      // Edge case: shouldn't apply both (double-strip is fine here since the result is the same)
      expect(normaliseAddonBase("https://torrentio.strem.fun/config/manifest.json"))
        .toBe("https://torrentio.strem.fun/config");
    });

    it("leaves plain base URL untouched", () => {
      expect(normaliseAddonBase("https://torrentio.strem.fun"))
        .toBe("https://torrentio.strem.fun");
    });

    it("handles URL with path segment (user config in path)", () => {
      expect(normaliseAddonBase("https://torrentio.strem.fun/debridoptions=RD/manifest.json"))
        .toBe("https://torrentio.strem.fun/debridoptions=RD");
    });
  });

  // -------------------------------------------------------------------------
  // 2. validateAddon — valid manifest
  // -------------------------------------------------------------------------
  describe("validateAddon — valid manifest", () => {
    it("returns ok: true with parsed manifest when addon is valid", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(manifestFixture),
      }));

      const result = await validateAddon("https://torrentio.strem.fun/manifest.json");

      expect(result.ok).toBe(true);
      expect(result.manifest).toBeDefined();
      expect(result.manifest!.name).toBe("Torrentio");
      expect(result.manifest!.resources).toContain("stream");
    });

    it("probes the correct manifest URL (strips /manifest.json then appends it)", async () => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(manifestFixture),
        };
      });

      await validateAddon("https://torrentio.strem.fun");
      expect(calls[0]).toBe("https://torrentio.strem.fun/manifest.json");
    });
  });

  // -------------------------------------------------------------------------
  // 3. validateAddon — missing "stream" resource
  // -------------------------------------------------------------------------
  describe("validateAddon — missing stream resource", () => {
    it("returns ok: false when resources does not include stream", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(manifestNoStreamFixture),
      }));

      const result = await validateAddon("https://catalog-only.example.com");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/stream/i);
    });
  });

  // -------------------------------------------------------------------------
  // 3b. validateAddon — object-form resources (Torrentio shape)
  // -------------------------------------------------------------------------
  describe("validateAddon — object-form resources", () => {
    it("accepts resources as array of { name } objects (Torrentio shape)", async () => {
      const manifest = await readFile(
        join(FIXTURES, "stremio-manifest-object-resources.json"),
        "utf8",
      );
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(manifest),
      }));

      const result = await validateAddon("https://torrentio.strem.fun/manifest.json");

      expect(result.ok).toBe(true);
      expect(result.manifest?.name).toBe("Torrentio");
      // Per-resource idPrefixes contains "tt" → no warning
      expect(result.warning).toBeUndefined();
    });

    it("rejects object-form resources without a stream entry", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: "test",
          name: "Test",
          version: "1.0",
          resources: [
            { name: "catalog", types: ["movie"] },
            { name: "meta", types: ["movie"] },
          ],
        }),
      }));

      const result = await validateAddon("https://no-stream.example.com");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/stream/i);
    });

    it("warns when per-resource idPrefixes lacks 'tt'", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: "anime",
          name: "AnimeOnly",
          version: "1.0",
          resources: [
            { name: "stream", types: ["anime"], idPrefixes: ["kitsu:"] },
          ],
        }),
      }));

      const result = await validateAddon("https://anime.example.com");

      expect(result.ok).toBe(true);
      expect(result.warning).toMatch(/IMDb/i);
    });
  });

  // -------------------------------------------------------------------------
  // 4. validateAddon — network error
  // -------------------------------------------------------------------------
  describe("validateAddon — network error", () => {
    it("returns ok: false with error string on network failure", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("ECONNREFUSED");
      });

      const result = await validateAddon("https://unreachable.example.com");

      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe("string");
      expect(result.error!.length).toBeGreaterThan(0);
    });

    it("returns ok: false when HTTP status is non-ok", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      }));

      const result = await validateAddon("https://missing.example.com");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("404");
    });
  });

  // -------------------------------------------------------------------------
  // 5. searchStremioMovie — no enabled addons → [] without fetching
  // -------------------------------------------------------------------------
  describe("searchStremioMovie — no enabled addons", () => {
    it("returns [] without making any fetches when no addons are enabled", async () => {
      mockSettings([
        { id: "a1", url: "https://disabled.example.com", name: "Disabled", enabled: false },
      ]);

      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const { results } = await searchStremioMovie("tt1375666");

      expect(results).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns [] for empty imdbId", async () => {
      mockSettings([
        { id: "a1", url: "https://torrentio.strem.fun", name: "Torrentio", enabled: true },
      ]);

      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const { results } = await searchStremioMovie("");

      expect(results).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. searchStremioMovie — parses streams fixture correctly
  // -------------------------------------------------------------------------
  describe("searchStremioMovie — stream parsing", () => {
    beforeEach(() => {
      mockSettings([
        { id: "a1", url: "https://torrentio.strem.fun", name: "Torrentio", enabled: true },
      ]);
      _clearCache();
    });

    it("returns 2 results (third stream — no infoHash/url — is dropped)", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(movieStreamsFixture),
      }));

      const { results } = await searchStremioMovie("tt0816692");

      expect(results).toHaveLength(2);
    });

    it("sets streamUrl for HTTP stream shape and empty magnet", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(movieStreamsFixture),
      }));

      const { results } = await searchStremioMovie("tt0816692");
      const httpResult = results.find((r) => r.streamUrl);

      expect(httpResult).toBeDefined();
      expect(httpResult!.streamUrl).toBe("https://download.real-debrid.com/d/abc123xyz/inception.mkv");
      expect(httpResult!.magnet).toBe("");
    });

    it("reconstructs magnet for infoHash stream shape", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(movieStreamsFixture),
      }));

      const { results } = await searchStremioMovie("tt0816692");
      const magnetResult = results.find((r) => r.magnet && r.magnet.startsWith("magnet:"));

      expect(magnetResult).toBeDefined();
      expect(magnetResult!.magnet).toContain("xt=urn:btih:");
      expect(magnetResult!.magnet).toContain("a94f3c2d1e8b4f7a9c0d2e5f8b1a3c6d9e2f4a7b");
    });

    it("sets source=stremio and addonOrigin on all results", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(movieStreamsFixture),
      }));

      const { results } = await searchStremioMovie("tt0816692");

      for (const r of results) {
        expect(r.source).toBe("stremio");
        expect(r.addonOrigin).toBe("Torrentio");
      }
    });

    it("sets fileIdx from stream.fileIdx for magnet shape", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(movieStreamsFixture),
      }));

      const { results } = await searchStremioMovie("tt0816692");
      const magnetResult = results.find((r) => r.magnet && r.magnet.startsWith("magnet:"));

      expect(magnetResult!.fileIdx).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Magnet reconstruction — trackers from sources[] and fallback
  // -------------------------------------------------------------------------
  describe("magnet reconstruction", () => {
    beforeEach(() => {
      mockSettings([
        { id: "a1", url: "https://torrentio.strem.fun", name: "Torrentio", enabled: true },
      ]);
      _clearCache();
    });

    it("uses trackers from sources[] when present", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(movieStreamsFixture),
      }));

      const { results } = await searchStremioMovie("tt0816692");
      const magnetResult = results.find((r) => r.magnet && r.magnet.startsWith("magnet:"));

      // The fixture has tracker:udp://tracker.opentrackr.org:1337/announce
      expect(magnetResult!.magnet).toContain(encodeURIComponent("udp://tracker.opentrackr.org:1337/announce"));
    });

    it("uses fallback trackers when sources[] is absent", async () => {
      const streamNoSources = {
        streams: [
          {
            name: "Test Addon 1080p",
            title: "Inception.2010.1080p.BluRay.x264",
            infoHash: "deadbeef1234567890abcdef1234567890abcdef",
            // No sources field
          },
        ],
      };

      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => streamNoSources,
      }));

      const { results } = await searchStremioMovie("tt1375666");

      expect(results).toHaveLength(1);
      // Should contain fallback tracker
      expect(results[0]!.magnet).toContain(
        encodeURIComponent(FALLBACK_TRACKERS[0]!),
      );
    });

    it("uses fallback trackers when sources[] contains only dht entries", async () => {
      const streamDhtOnly = {
        streams: [
          {
            name: "Test 720p",
            title: "Movie.2020.720p.x264",
            infoHash: "cafebabe1234567890abcdef1234567890abcdef",
            sources: ["dht:cafebabe1234567890abcdef1234567890abcdef"],
          },
        ],
      };

      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => streamDhtOnly,
      }));

      const { results } = await searchStremioMovie("tt9999999");

      expect(results).toHaveLength(1);
      expect(results[0]!.magnet).toContain(
        encodeURIComponent(FALLBACK_TRACKERS[0]!),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 8. Dedupe — same infoHash from two addons → one result (first-wins)
  // -------------------------------------------------------------------------
  describe("dedupe", () => {
    it("dedupes by infoHash — first addon's addonOrigin wins", async () => {
      mockSettings([
        { id: "a1", url: "https://addon1.example.com", name: "Addon One", enabled: true },
        { id: "a2", url: "https://addon2.example.com", name: "Addon Two", enabled: true },
      ]);
      _clearCache();

      const sameHash = "a94f3c2d1e8b4f7a9c0d2e5f8b1a3c6d9e2f4a7b";
      const sharedStream = {
        streams: [
          {
            name: "Both Addons 1080p",
            title: "Inception.2010.1080p.BluRay.x264",
            infoHash: sameHash,
            sources: ["tracker:udp://tracker.opentrackr.org:1337/announce"],
          },
        ],
      };

      vi.stubGlobal("fetch", async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => {
          // Both addons return the same infoHash
          void url;
          return sharedStream;
        },
      }));

      const { results } = await searchStremioMovie("tt1375666");

      // Should be deduped to 1 result
      expect(results).toHaveLength(1);
      // First addon wins
      expect(results[0]!.addonOrigin).toBe("Addon One");
    });

    it("dedupes by streamUrl — first-wins", async () => {
      mockSettings([
        { id: "b1", url: "https://addon1.example.com", name: "First Addon", enabled: true },
        { id: "b2", url: "https://addon2.example.com", name: "Second Addon", enabled: true },
      ]);
      _clearCache();

      const sharedUrl = "https://cdn.example.com/movie.mkv";

      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          streams: [{ name: "CDN Stream", title: "Movie 1080p x264", url: sharedUrl }],
        }),
      }));

      const { results } = await searchStremioMovie("tt2222222");

      expect(results).toHaveLength(1);
      expect(results[0]!.addonOrigin).toBe("First Addon");
    });
  });

  // -------------------------------------------------------------------------
  // 9. Promise.allSettled — one addon fails, other returns results
  // -------------------------------------------------------------------------
  describe("Promise.allSettled semantics", () => {
    it("returns results from working addon even when another fails", async () => {
      mockSettings([
        { id: "c1", url: "https://broken.example.com", name: "Broken Addon", enabled: true },
        { id: "c2", url: "https://working.example.com", name: "Working Addon", enabled: true },
      ]);
      _clearCache();

      vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("broken.example.com")) {
          throw new Error("Connection refused");
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            streams: [
              {
                name: "Working 1080p",
                title: "Inception.2010.1080p.BluRay.x264-YIFY",
                infoHash: "1111111111111111111111111111111111111111",
                sources: ["tracker:udp://tracker.opentrackr.org:1337/announce"],
              },
              {
                name: "Working RD",
                title: "Inception 2010 4K",
                url: "https://real-debrid.com/d/xyz/inception.mkv",
              },
            ],
          }),
        };
      });

      const { results, errors } = await searchStremioMovie("tt1375666");

      // Should get 2 results from the working addon, none from the broken one
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.addonOrigin).toBe("Working Addon");
      }
      // Broken addon should produce one error entry
      expect(errors).toHaveLength(1);
      expect(errors[0]!.addonId).toBe("c1");
      expect(errors[0]!.addonName).toBe("Broken Addon");
      expect(errors[0]!.code).toBe("fetch");
    });
  });

  // -------------------------------------------------------------------------
  // Extra: searchStremioEpisode URL shape
  // -------------------------------------------------------------------------
  describe("searchStremioEpisode", () => {
    it("constructs the correct series URL path", async () => {
      mockSettings([
        { id: "d1", url: "https://torrentio.strem.fun", name: "Torrentio", enabled: true },
      ]);
      _clearCache();

      const calledUrls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        calledUrls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ streams: [] }),
        };
      });

      const outcome = await searchStremioEpisode("tt0903747", 1, 5);

      expect(calledUrls[0]).toContain("/stream/series/tt0903747:1:5.json");
      expect(outcome.results).toEqual([]);
      expect(outcome.errors).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 5 — adapter fixes
  // -------------------------------------------------------------------------

  describe("buildMagnetFromStream — tracker scheme filtering (Phase 5a)", () => {
    beforeEach(() => {
      mockSettings([
        { id: "e1", url: "https://torrentio.strem.fun", name: "Torrentio", enabled: true },
      ]);
      _clearCache();
    });

    it("keeps only udp:// and http(s):// tracker entries; drops wss:// and bare-host entries", async () => {
      const mixedSources = {
        streams: [
          {
            name: "Filtered 1080p",
            title: "Inception.2010.1080p.BluRay.x264",
            infoHash: "aabbcc1111111111111111111111111111111111",
            sources: [
              "tracker:udp://valid.example:80",
              "tracker:wss://bad.example",
              "tracker:plain.host:1337",
            ],
          },
        ],
      };

      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => mixedSources,
      }));

      const { results } = await searchStremioMovie("tt9000001");

      expect(results).toHaveLength(1);
      const magnet = results[0]!.magnet;
      // Only the udp:// tracker should appear
      expect(magnet).toContain(encodeURIComponent("udp://valid.example:80"));
      expect(magnet).not.toContain("wss%3A");
      expect(magnet).not.toContain("plain.host");
      // Fallback trackers must NOT appear — at least one valid tracker was found
      expect(magnet).not.toContain(encodeURIComponent(FALLBACK_TRACKERS[0]!));
    });
  });

  describe("Torrentio downloading-placeholder filter", () => {
    it("drops streams whose url is the Torrentio downloading_v2.mp4 placeholder", async () => {
      mockSettings([
        { id: "f1", url: "https://torrentio.strem.fun", name: "Torrentio", enabled: true },
      ]);
      _clearCache();

      const placeholderResponse = {
        streams: [
          {
            name: "Torrentio RD download",
            title: "Some.Movie.2024.1080p",
            url: "https://torrentio.strem.fun/videos/downloading_v2.mp4",
          },
          {
            name: "Torrentio RD",
            title: "Some.Movie.2024.1080p",
            url: "https://download.real-debrid.com/d/abc/movie.mkv",
          },
        ],
      };

      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => placeholderResponse,
      }));

      const { results } = await searchStremioMovie("tt9000099");

      expect(results).toHaveLength(1);
      expect(results[0]!.streamUrl).toContain("real-debrid.com");
    });
  });

  describe("HTTP-shape sort boost within same rank bucket (Phase 5b)", () => {
    it("places streamUrl result above magnet-only result of identical title/resolution", async () => {
      mockSettings([
        { id: "f1", url: "https://torrentio.strem.fun", name: "Torrentio", enabled: true },
      ]);
      _clearCache();

      // Both streams have identical title so rankTorrent ties them;
      // the streamUrl one should sort first.
      const tiedStreams = {
        streams: [
          {
            name: "Torrentio 1080p",
            title: "Inception.2010.1080p.BluRay.x264",
            infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            sources: ["tracker:udp://tracker.opentrackr.org:1337/announce"],
          },
          {
            name: "Torrentio RD 1080p",
            title: "Inception.2010.1080p.BluRay.x264",
            url: "https://download.real-debrid.com/d/xyz/inception.mkv",
          },
        ],
      };

      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => tiedStreams,
      }));

      const { results } = await searchStremioMovie("tt9000002");

      expect(results).toHaveLength(2);
      // HTTP-shape (streamUrl) must be first
      expect(results[0]!.streamUrl).toBeDefined();
      expect(results[1]!.magnet).toMatch(/^magnet:/);
    });
  });

  describe("validateAddon — idPrefixes warning (Phase 5c)", () => {
    it("returns warning when idPrefixes is present and does not include 'tt'", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(manifestKitsuOnlyFixture),
      }));

      const result = await validateAddon("https://kitsu.example.com");

      expect(result.ok).toBe(true);
      expect(result.manifest).toBeDefined();
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("IMDb");
    });

    it("does not warn when idPrefixes is absent (unconstrained addon)", async () => {
      // stremio-manifest.json has no idPrefixes field
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(manifestFixture),
      }));

      const result = await validateAddon("https://torrentio.strem.fun");

      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it("does not warn when idPrefixes includes 'tt'", async () => {
      const manifestWithTt = {
        id: "org.example.tt",
        version: "1.0.0",
        name: "IMDb Addon",
        resources: ["stream"],
        types: ["movie"],
        idPrefixes: ["tt", "kitsu:"],
      };

      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => manifestWithTt,
      }));

      const result = await validateAddon("https://imdb.example.com");

      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  describe("validateAddon — behaviorHints.configurationRequired warning (Phase 5c)", () => {
    it("returns warning when configurationRequired is true", async () => {
      const manifestRequiresConfig = {
        id: "org.example.config",
        version: "1.0.0",
        name: "Needs Config Addon",
        resources: ["stream"],
        types: ["movie"],
        behaviorHints: { configurationRequired: true },
      };

      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => manifestRequiresConfig,
      }));

      const result = await validateAddon("https://config-required.example.com");

      expect(result.ok).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("configuration");
    });

    it("does not warn when configurationRequired is false", async () => {
      const manifestNoConfig = {
        id: "org.example.noconfig",
        version: "1.0.0",
        name: "No Config Addon",
        resources: ["stream"],
        types: ["movie"],
        behaviorHints: { configurationRequired: false },
      };

      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => manifestNoConfig,
      }));

      const result = await validateAddon("https://no-config.example.com");

      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it("does not warn when behaviorHints is absent", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(manifestFixture),
      }));

      const result = await validateAddon("https://torrentio.strem.fun");

      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  describe("validateAddon — combined warning (Phase 5c)", () => {
    it("concatenates both warnings with ' / ' when both conditions fire", async () => {
      const manifestBoth = {
        id: "org.example.both",
        version: "1.0.0",
        name: "Both Issues Addon",
        resources: ["stream"],
        types: ["movie"],
        idPrefixes: ["kitsu:"],
        behaviorHints: { configurationRequired: true },
      };

      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        json: async () => manifestBoth,
      }));

      const result = await validateAddon("https://both.example.com");

      expect(result.ok).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("IMDb");
      expect(result.warning).toContain("configuration");
      expect(result.warning).toContain(" / ");
    });
  });
});
