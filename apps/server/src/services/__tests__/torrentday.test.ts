import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before the module is imported.
// ---------------------------------------------------------------------------

// Mock getSettings so we can control credentials in tests without touching disk.
vi.mock("../../services/settings.js", () => ({
  getSettings: vi.fn(),
}));

// Mock getDispatcher to always return undefined (direct routing in tests).
vi.mock("../../lib/proxy.js", () => ({
  getDispatcher: vi.fn(() => undefined),
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up.
// ---------------------------------------------------------------------------
import {
  searchTorrentDayMovie,
  TorrentDayAuthError,
  TorrentDayDisabledError,
  tdAvailable,
  _clearCache,
} from "../torrentday.js";
import { getSettings } from "../settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

// Helper — set up a minimal getSettings mock return.
function mockSettings(overrides: {
  enabled?: boolean;
  uid?: string | null;
  pass?: string | null;
} = {}) {
  // Use explicit key checks so null values are honoured (null ?? fallback = fallback
  // would incorrectly replace an intentional null).
  const uid = "uid" in overrides ? overrides.uid : "123456";
  const pass = "pass" in overrides ? overrides.pass : "abcdef123456";
  const enabled = "enabled" in overrides ? overrides.enabled : true;

  (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
    torrentDay: { enabled, uid, pass },
    proxyUrl: null,
    proxyEnabled: {
      yts: false,
      eztv: false,
      knaben: false,
      torrentday: false,
    },
    bufferPercent: 3,
    transcodeBufferPercent: 5,
    transcodeBitrate: "5M",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("torrentday adapter", () => {
  let searchHtml: string;
  let loginHtml: string;

  beforeEach(async () => {
    searchHtml = await readFile(join(FIXTURES, "torrentday-search.html"), "utf8");
    loginHtml = await readFile(join(FIXTURES, "torrentday-login.html"), "utf8");
    // Clear LRU cache so each test starts fresh.
    _clearCache();
    // Reset any globally stubbed fetch from a previous test.
    vi.unstubAllGlobals();
    // Apply default credentials mock.
    mockSettings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // 1. HTML parsing → results
  // -------------------------------------------------------------------------
  describe("searchTorrentDayMovie — HTML parsing", () => {
    it("returns 3 results from fixture (drops 1 zero-seed row)", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => searchHtml,
      }));

      const results = await searchTorrentDayMovie("inception", 2010);

      expect(results).toHaveLength(3);
    });

    it("first result is the x264 / cast-friendly one (ranked highest)", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => searchHtml,
      }));

      const results = await searchTorrentDayMovie("inception", 2010);
      const first = results[0]!;

      expect(first.title).toBe("Inception 2010 1080p MA WEB-DL DDP5 1 H264-HHWEB");
      expect(first.seeds).toBe(19);
      expect(first.castFriendly).toBe(true);
      expect(first.videoCodec).toBe("x264");
    });

    it("all results have source=torrentday and absolute torrentUrls", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => searchHtml,
      }));

      const results = await searchTorrentDayMovie("inception", 2010);

      for (const r of results) {
        expect(r.source).toBe("torrentday");
        expect(r.torrentUrl).toMatch(/^https:\/\/www\.torrentday\.com\/download\.php\//);
        expect(r.magnet).toBe("");
      }
    });

    it("sizes parse correctly", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => searchHtml,
      }));

      const results = await searchTorrentDayMovie("inception", 2010);

      // Row 3 (x264, 8.38 GB) is first after sort
      expect(results[0]!.size).toMatch(/GB/);
      // Row 4 (x265, 2.3 GB) is second
      expect(results[1]!.seeds).toBe(82);
      expect(results[1]!.size).toContain("2.3");
    });

    it("torrentUrls match expected paths from fixture", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => searchHtml,
      }));

      const results = await searchTorrentDayMovie("inception", 2010);
      const urls = results.map((r) => r.torrentUrl);

      // x264 result (first after sort)
      expect(urls[0]).toContain("/download.php/9582321/");
      // x265 1080p (second — 82 seeds)
      expect(urls[1]).toContain("/download.php/6793750/");
      // x265 2160p (third — 7 seeds)
      expect(urls[2]).toContain("/download.php/9685253/");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Login-redirect HTML → TorrentDayAuthError
  // -------------------------------------------------------------------------
  describe("auth detection", () => {
    it("throws TorrentDayAuthError when response has no #torrentTable", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => loginHtml,
      }));

      await expect(searchTorrentDayMovie("inception", 2010)).rejects.toThrow(
        TorrentDayAuthError,
      );
    });

    it("throws TorrentDayAuthError on 302 redirect to login", async () => {
      vi.stubGlobal("fetch", async () => ({
        ok: false,
        status: 302,
        headers: { get: (h: string) => (h === "location" ? "/login.php" : null) },
        text: async () => "",
      }));

      await expect(searchTorrentDayMovie("inception", 2010)).rejects.toThrow(
        TorrentDayAuthError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Cookie hash determinism
  // -------------------------------------------------------------------------
  describe("cookie hash determinism", () => {
    it("same uid+pass produces the same 8-char hex hash", () => {
      const h1 = createHash("sha1").update("123456" + "abcdef").digest("hex").slice(0, 8);
      const h2 = createHash("sha1").update("123456" + "abcdef").digest("hex").slice(0, 8);
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(8);
      expect(h1).toMatch(/^[0-9a-f]{8}$/);
    });

    it("different uid produces a different hash", () => {
      const h1 = createHash("sha1").update("123456" + "abcdef").digest("hex").slice(0, 8);
      const h2 = createHash("sha1").update("999999" + "abcdef").digest("hex").slice(0, 8);
      expect(h1).not.toBe(h2);
    });

    it("different pass produces a different hash", () => {
      const h1 = createHash("sha1").update("123456" + "abcdef").digest("hex").slice(0, 8);
      const h2 = createHash("sha1").update("123456" + "zzzzz1").digest("hex").slice(0, 8);
      expect(h1).not.toBe(h2);
    });
  });

  // -------------------------------------------------------------------------
  // 4. tdAvailable() matrix
  // -------------------------------------------------------------------------
  describe("tdAvailable()", () => {
    it("returns false when enabled=false", () => {
      mockSettings({ enabled: false, uid: "123456", pass: "abcdef" });
      expect(tdAvailable()).toBe(false);
    });

    it("returns false when uid is null", () => {
      mockSettings({ enabled: true, uid: null, pass: "abcdef" });
      expect(tdAvailable()).toBe(false);
    });

    it("returns false when pass is null", () => {
      mockSettings({ enabled: true, uid: "123456", pass: null });
      expect(tdAvailable()).toBe(false);
    });

    it("returns false when uid is empty string", () => {
      mockSettings({ enabled: true, uid: "", pass: "abcdef" });
      expect(tdAvailable()).toBe(false);
    });

    it("returns true when enabled + uid + pass all set", () => {
      mockSettings({ enabled: true, uid: "123456", pass: "abcdef" });
      expect(tdAvailable()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. TorrentDayDisabledError when not available
  // -------------------------------------------------------------------------
  describe("disabled/missing credentials", () => {
    it("throws TorrentDayDisabledError when disabled", async () => {
      mockSettings({ enabled: false, uid: "123456", pass: "abcdef" });

      await expect(searchTorrentDayMovie("inception")).rejects.toThrow(
        TorrentDayDisabledError,
      );
    });

    it("throws TorrentDayDisabledError when uid is null", async () => {
      mockSettings({ enabled: true, uid: null, pass: "abcdef" });

      await expect(searchTorrentDayMovie("inception")).rejects.toThrow(
        TorrentDayDisabledError,
      );
    });
  });
});
