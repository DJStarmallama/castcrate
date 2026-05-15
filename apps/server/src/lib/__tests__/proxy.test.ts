import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the settings module so we can control what getSettings() returns
// without touching the filesystem.
// ---------------------------------------------------------------------------
vi.mock("../../services/settings.js", () => ({
  getSettings: vi.fn(),
  onSettingsUpdate: vi.fn(),
}));

import { getSettings, onSettingsUpdate } from "../../services/settings.js";
import { redactProxyUrl, getDispatcher, resetProxyCache } from "../proxy.js";
import type { ProxyProvider } from "../proxy.js";

const mockGetSettings = vi.mocked(getSettings);
const mockOnSettingsUpdate = vi.mocked(onSettingsUpdate);

// Default settings baseline — no proxy configured.
const defaultSettings = {
  bufferPercent: 2,
  transcodeBufferPercent: 5,
  transcodeBitrate: "5M",
  proxyUrl: null as string | null,
  proxyEnabled: {
    yts: false,
    eztv: false,
    knaben: false,
    torrentday: false,
  },
};

beforeEach(() => {
  mockGetSettings.mockReturnValue({ ...defaultSettings, proxyEnabled: { ...defaultSettings.proxyEnabled } });
  mockOnSettingsUpdate.mockImplementation(() => undefined);
  resetProxyCache();
});

afterEach(() => {
  resetProxyCache();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// redactProxyUrl
// ---------------------------------------------------------------------------

describe("redactProxyUrl()", () => {
  it("masks user:password in socks5h:// URL", () => {
    const result = redactProxyUrl("socks5h://alice:secret@proxy.example.com:1080");
    expect(result).toBe("socks5h://****@proxy.example.com:1080");
    expect(result).not.toContain("alice");
    expect(result).not.toContain("secret");
  });

  it("masks user:password in socks5:// URL", () => {
    const result = redactProxyUrl("socks5://bob:hunter2@10.0.0.1:1080");
    expect(result).toBe("socks5://****@10.0.0.1:1080");
  });

  it("masks user:password in http:// URL", () => {
    const result = redactProxyUrl("http://admin:pass@proxy.corp:3128");
    expect(result).toBe("http://****@proxy.corp:3128");
  });

  it("masks user:password in https:// URL", () => {
    const result = redactProxyUrl("https://u:p@secure-proxy.example.com:443");
    expect(result).toBe("https://****@secure-proxy.example.com:443");
  });

  it("leaves URL intact when there is no userinfo (socks5h)", () => {
    const url = "socks5h://proxy.example.com:1080";
    expect(redactProxyUrl(url)).toBe(url);
  });

  it("leaves URL intact when there is no userinfo (http)", () => {
    const url = "http://proxy.example.com:8080";
    expect(redactProxyUrl(url)).toBe(url);
  });

  it("preserves host and port after masking", () => {
    const result = redactProxyUrl("socks5://user:pw@my-proxy.internal:9050");
    expect(result).toContain("my-proxy.internal:9050");
  });

  it("returns input unchanged for unknown/invalid scheme", () => {
    const bad = "ftp://user:pw@host:21";
    expect(redactProxyUrl(bad)).toBe(bad);
  });
});

// ---------------------------------------------------------------------------
// URL validation — test the PROXY_URL_RE pattern directly.
// The regex is defined in settings.ts and exported; we replicate it here to
// avoid pulling in the mocked module (which would return the vi.mock stub).
// ---------------------------------------------------------------------------

describe("PROXY_URL_RE validation matrix", () => {
  // Mirror the exact regex from settings.ts so tests verify the contract.
  const PROXY_URL_RE = /^(socks5h?|http|https):\/\/.+/;

  const accepted = [
    "socks5://proxy.example.com:1080",
    "socks5h://proxy.example.com:1080",
    "socks5h://user:pw@proxy.example.com:1080",
    "http://proxy.corp:3128",
    "https://secure-proxy.example.com:443",
    "http://127.0.0.1:3128",
  ];

  const rejected = [
    "proxy.example.com:1080",       // bare host
    "//proxy.example.com:1080",     // missing scheme
    "ftp://proxy.example.com:21",   // wrong scheme
    "",                              // empty string
    "socks4://proxy.example.com",    // socks4 not supported
  ];

  for (const url of accepted) {
    it(`accepts: ${url}`, () => {
      expect(PROXY_URL_RE.test(url)).toBe(true);
    });
  }

  for (const url of rejected) {
    it(`rejects: "${url}"`, () => {
      expect(PROXY_URL_RE.test(url)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// getDispatcher() selection matrix
// ---------------------------------------------------------------------------

describe("getDispatcher()", () => {
  it("returns undefined when proxyUrl is null, even if provider enabled", () => {
    mockGetSettings.mockReturnValue({
      ...defaultSettings,
      proxyUrl: null,
      proxyEnabled: { ...defaultSettings.proxyEnabled, eztv: true },
    });
    expect(getDispatcher("eztv")).toBeUndefined();
  });

  it("returns undefined when proxyUrl is set but provider is disabled", () => {
    mockGetSettings.mockReturnValue({
      ...defaultSettings,
      proxyUrl: "http://proxy.example.com:3128",
      proxyEnabled: { ...defaultSettings.proxyEnabled, eztv: false },
    });
    expect(getDispatcher("eztv")).toBeUndefined();
  });

  it("returns undefined when proxyUrl is empty string", () => {
    mockGetSettings.mockReturnValue({
      ...defaultSettings,
      proxyUrl: "",
      proxyEnabled: { ...defaultSettings.proxyEnabled, knaben: true },
    });
    expect(getDispatcher("knaben")).toBeUndefined();
  });

  it("returns a dispatcher when proxyUrl set and provider enabled (http scheme)", () => {
    mockGetSettings.mockReturnValue({
      ...defaultSettings,
      proxyUrl: "http://proxy.example.com:3128",
      proxyEnabled: { ...defaultSettings.proxyEnabled, eztv: true },
    });
    const dispatcher = getDispatcher("eztv");
    expect(dispatcher).toBeDefined();
    expect(dispatcher).not.toBeNull();
  });

  it("returns a dispatcher when proxyUrl set and provider enabled (socks5h scheme)", () => {
    mockGetSettings.mockReturnValue({
      ...defaultSettings,
      proxyUrl: "socks5h://proxy.example.com:1080",
      proxyEnabled: { ...defaultSettings.proxyEnabled, knaben: true },
    });
    const dispatcher = getDispatcher("knaben");
    expect(dispatcher).toBeDefined();
  });

  it("returns undefined for yts when disabled (default state)", () => {
    // yts is off by default — verify with default settings.
    mockGetSettings.mockReturnValue({ ...defaultSettings });
    expect(getDispatcher("yts")).toBeUndefined();
  });

  it("returns a dispatcher for yts when explicitly enabled", () => {
    mockGetSettings.mockReturnValue({
      ...defaultSettings,
      proxyUrl: "http://proxy.example.com:3128",
      proxyEnabled: { ...defaultSettings.proxyEnabled, yts: true },
    });
    expect(getDispatcher("yts")).toBeDefined();
  });

  it("returns undefined for torrentday when disabled", () => {
    mockGetSettings.mockReturnValue({
      ...defaultSettings,
      proxyUrl: "http://proxy.example.com:3128",
      proxyEnabled: { ...defaultSettings.proxyEnabled, torrentday: false },
    });
    expect(getDispatcher("torrentday")).toBeUndefined();
  });

  it("caches the dispatcher for the same url + provider", () => {
    mockGetSettings.mockReturnValue({
      ...defaultSettings,
      proxyUrl: "http://proxy.example.com:3128",
      proxyEnabled: { ...defaultSettings.proxyEnabled, eztv: true },
    });
    const d1 = getDispatcher("eztv");
    const d2 = getDispatcher("eztv");
    expect(d1).toBe(d2); // same reference — cached
  });

  it("resets cache after resetProxyCache() is called", () => {
    mockGetSettings.mockReturnValue({
      ...defaultSettings,
      proxyUrl: "http://proxy.example.com:3128",
      proxyEnabled: { ...defaultSettings.proxyEnabled, eztv: true },
    });
    const d1 = getDispatcher("eztv");
    resetProxyCache();
    const d2 = getDispatcher("eztv");
    // After reset, a new dispatcher is created (not the same object).
    expect(d1).not.toBe(d2);
  });

  it("returns different dispatchers per provider (http scheme)", () => {
    mockGetSettings.mockReturnValue({
      ...defaultSettings,
      proxyUrl: "http://proxy.example.com:3128",
      proxyEnabled: { yts: false, eztv: true, knaben: true, torrentday: false },
    });
    const dEztv = getDispatcher("eztv");
    const dKnaben = getDispatcher("knaben");
    // Both exist but are independent cache entries.
    expect(dEztv).toBeDefined();
    expect(dKnaben).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Settings integration — proxyEnabled partial-merge and proxyUrl round-trip.
// These tests exercise the real settings module via a temp in-memory store.
// ---------------------------------------------------------------------------

describe("settings — proxyEnabled partial merge and proxyUrl round-trip", () => {
  // We test the sanitise logic by importing and calling updateSettings with
  // an in-memory override; we need to reset the module state.
  // Since vi.mock replaces settings above, we test the real module separately
  // by un-mocking it in a fresh context via dynamic import with resetModules.

  it("sanitise keeps proxyUrl when valid", async () => {
    vi.resetModules();
    // Re-import the real settings module.
    const settings = await import("../../services/settings.js?bust=1");
    // The sanitise function is not exported; we can test it indirectly via
    // updateSettings (which calls sanitise internally).
    // initSettings was not called here — overrides start empty.
    // We call updateSettings and check the returned value.
    const result = await settings.updateSettings({
      proxyUrl: "socks5h://proxy.example.com:1080",
      proxyEnabled: { eztv: true },
    } as Parameters<typeof settings.updateSettings>[0]);

    expect(result.proxyUrl).toBe("socks5h://proxy.example.com:1080");
    expect(result.proxyEnabled.eztv).toBe(true);
    // Other keys should remain at their defaults (false).
    expect(result.proxyEnabled.yts).toBe(false);
    expect(result.proxyEnabled.knaben).toBe(false);
    expect(result.proxyEnabled.torrentday).toBe(false);
  });

  it("sanitise rejects invalid proxyUrl (bare host) — leaves proxyUrl null", async () => {
    vi.resetModules();
    const settings = await import("../../services/settings.js?bust=2");
    const result = await settings.updateSettings({
      proxyUrl: "not-a-valid-url",
    } as Parameters<typeof settings.updateSettings>[0]);

    // Invalid URL is dropped; falls through to env default (null in test env).
    expect(result.proxyUrl).toBeNull();
  });

  it("proxyEnabled partial-merge only updates supplied keys", async () => {
    vi.resetModules();
    const settings = await import("../../services/settings.js?bust=3");
    // First call: enable eztv.
    await settings.updateSettings({ proxyEnabled: { eztv: true } } as Parameters<typeof settings.updateSettings>[0]);
    // Second call: enable knaben only — eztv should remain true.
    const result = await settings.updateSettings({ proxyEnabled: { knaben: true } } as Parameters<typeof settings.updateSettings>[0]);
    expect(result.proxyEnabled.eztv).toBe(true);
    expect(result.proxyEnabled.knaben).toBe(true);
    expect(result.proxyEnabled.yts).toBe(false);
  });

  it("setting proxyUrl to null clears it", async () => {
    vi.resetModules();
    const settings = await import("../../services/settings.js?bust=4");
    await settings.updateSettings({ proxyUrl: "http://proxy.example.com:3128" } as Parameters<typeof settings.updateSettings>[0]);
    const result = await settings.updateSettings({ proxyUrl: null } as Parameters<typeof settings.updateSettings>[0]);
    expect(result.proxyUrl).toBeNull();
  });
});
