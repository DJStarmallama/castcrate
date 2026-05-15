/**
 * Settings sanitiser tests — TorrentDay block.
 *
 * Tests run against the real sanitise() internals through updateSettings().
 * We mock the filesystem so no actual ~/.castcrate files are created.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock filesystem so nothing is read/written during tests.
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("no file")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

import { initSettings, getSettings, updateSettings } from "../settings.js";

beforeEach(async () => {
  // Re-init to a clean state before each test.
  await initSettings();
});

describe("settings — torrentDay block", () => {
  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------
  it("has correct defaults for torrentDay block", () => {
    const s = getSettings();
    expect(s.torrentDay).toEqual({ enabled: false, uid: null, pass: null });
  });

  // -------------------------------------------------------------------------
  // Round-trip — set valid values, read them back.
  // -------------------------------------------------------------------------
  it("round-trips enabled=true + valid uid + valid pass", async () => {
    await updateSettings({
      torrentDay: { enabled: true, uid: "123456", pass: "Abc123" },
    });
    const s = getSettings();
    expect(s.torrentDay.enabled).toBe(true);
    expect(s.torrentDay.uid).toBe("123456");
    expect(s.torrentDay.pass).toBe("Abc123");
  });

  // -------------------------------------------------------------------------
  // Partial merge — sending only { enabled: true } preserves existing creds.
  // -------------------------------------------------------------------------
  it("partial merge preserves existing uid and pass", async () => {
    await updateSettings({
      torrentDay: { enabled: false, uid: "789012", pass: "XyZ456" },
    });
    await updateSettings({ torrentDay: { enabled: true } });
    const s = getSettings();
    expect(s.torrentDay.enabled).toBe(true);
    expect(s.torrentDay.uid).toBe("789012");
    expect(s.torrentDay.pass).toBe("XyZ456");
  });

  // -------------------------------------------------------------------------
  // Null reset — sending { torrentDay: null } resets to defaults.
  // -------------------------------------------------------------------------
  it("null reset clears the entire torrentDay block", async () => {
    await updateSettings({
      torrentDay: { enabled: true, uid: "123456", pass: "Abc123" },
    });
    // Cast to any to satisfy TypeScript since the interface doesn't expose null directly.
    await updateSettings({ torrentDay: null as unknown as undefined });
    const s = getSettings();
    expect(s.torrentDay).toEqual({ enabled: false, uid: null, pass: null });
  });

  // -------------------------------------------------------------------------
  // uid validation — must be digits only.
  // -------------------------------------------------------------------------
  it("rejects non-digit uid", async () => {
    await updateSettings({
      torrentDay: { enabled: true, uid: "abc123", pass: "validPass1" },
    });
    const s = getSettings();
    // uid was invalid → remains at default (null)
    expect(s.torrentDay.uid).toBeNull();
  });

  it("accepts digit-only uid", async () => {
    await updateSettings({
      torrentDay: { enabled: true, uid: "987654", pass: "validPass1" },
    });
    const s = getSettings();
    expect(s.torrentDay.uid).toBe("987654");
  });

  it("treats empty uid as null", async () => {
    await updateSettings({
      torrentDay: { enabled: true, uid: "", pass: "validPass1" },
    });
    const s = getSettings();
    expect(s.torrentDay.uid).toBeNull();
  });

  // -------------------------------------------------------------------------
  // pass validation — must be alphanumeric [A-Za-z0-9]+.
  // -------------------------------------------------------------------------
  it("rejects pass with special characters", async () => {
    await updateSettings({
      torrentDay: { enabled: true, uid: "123456", pass: "bad-pass!" },
    });
    const s = getSettings();
    // pass was invalid → remains at default (null)
    expect(s.torrentDay.pass).toBeNull();
  });

  it("accepts alphanumeric pass", async () => {
    await updateSettings({
      torrentDay: { enabled: true, uid: "123456", pass: "GoodPass123" },
    });
    const s = getSettings();
    expect(s.torrentDay.pass).toBe("GoodPass123");
  });

  it("treats empty pass as null", async () => {
    await updateSettings({
      torrentDay: { enabled: true, uid: "123456", pass: "" },
    });
    const s = getSettings();
    expect(s.torrentDay.pass).toBeNull();
  });

  // -------------------------------------------------------------------------
  // enabled coercion — boolean.
  // -------------------------------------------------------------------------
  it("coerces truthy values for enabled", async () => {
    await updateSettings({
      torrentDay: { enabled: 1 as unknown as boolean, uid: null, pass: null },
    });
    const s = getSettings();
    expect(s.torrentDay.enabled).toBe(true);
  });

  it("coerces falsy values for enabled", async () => {
    await updateSettings({
      torrentDay: { enabled: true, uid: null, pass: null },
    });
    await updateSettings({
      torrentDay: { enabled: 0 as unknown as boolean },
    });
    const s = getSettings();
    expect(s.torrentDay.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stremioAddons block
// ---------------------------------------------------------------------------
describe("settings — stremioAddons block", () => {
  it("has empty array as default", () => {
    const s = getSettings();
    expect(s.stremioAddons).toEqual([]);
  });

  it("round-trips a valid addon array", async () => {
    await updateSettings({
      stremioAddons: [
        { id: "abc12345", url: "https://torrentio.strem.fun", name: "Torrentio", enabled: true },
      ],
    });
    const s = getSettings();
    expect(s.stremioAddons).toHaveLength(1);
    expect(s.stremioAddons[0]!.url).toBe("https://torrentio.strem.fun");
    expect(s.stremioAddons[0]!.name).toBe("Torrentio");
    expect(s.stremioAddons[0]!.enabled).toBe(true);
    expect(s.stremioAddons[0]!.id).toBe("abc12345");
  });

  it("whole-array replace — sending new array replaces existing", async () => {
    await updateSettings({
      stremioAddons: [
        { id: "aaa11111", url: "https://first.example.com", name: "First", enabled: true },
      ],
    });
    await updateSettings({
      stremioAddons: [
        { id: "bbb22222", url: "https://second.example.com", name: "Second", enabled: false },
      ],
    });
    const s = getSettings();
    expect(s.stremioAddons).toHaveLength(1);
    expect(s.stremioAddons[0]!.url).toBe("https://second.example.com");
  });

  it("rejects addon with invalid URL (missing scheme)", async () => {
    await updateSettings({
      stremioAddons: [
        { id: "ccc33333", url: "not-a-url", name: "Bad", enabled: true },
      ],
    });
    const s = getSettings();
    // Invalid URL → entry dropped → array is empty
    expect(s.stremioAddons).toHaveLength(0);
  });

  it("rejects addon with ftp:// URL (only http/https allowed)", async () => {
    await updateSettings({
      stremioAddons: [
        { id: "ddd44444", url: "ftp://example.com/manifest.json", name: "FTP", enabled: true },
      ],
    });
    const s = getSettings();
    expect(s.stremioAddons).toHaveLength(0);
  });

  it("accepts http:// URLs as well as https://", async () => {
    await updateSettings({
      stremioAddons: [
        { id: "eee55555", url: "http://localhost:7000", name: "Local", enabled: true },
      ],
    });
    const s = getSettings();
    expect(s.stremioAddons).toHaveLength(1);
    expect(s.stremioAddons[0]!.url).toBe("http://localhost:7000");
  });

  it("drops addon entry without an id", async () => {
    await updateSettings({
      stremioAddons: [
        { id: "", url: "https://torrentio.strem.fun", name: "Torrentio", enabled: true },
      ],
    });
    const s = getSettings();
    expect(s.stremioAddons).toHaveLength(0);
  });

  it("drops addon entry with no id field at all", async () => {
    await updateSettings({
      stremioAddons: [
        { url: "https://torrentio.strem.fun", name: "Torrentio", enabled: true } as unknown as { id: string; url: string; name: string; enabled: boolean },
      ],
    });
    const s = getSettings();
    expect(s.stremioAddons).toHaveLength(0);
  });

  it("truncates name to 60 characters", async () => {
    const longName = "A".repeat(100);
    await updateSettings({
      stremioAddons: [
        { id: "fff66666", url: "https://example.com", name: longName, enabled: true },
      ],
    });
    const s = getSettings();
    expect(s.stremioAddons[0]!.name).toHaveLength(60);
  });

  it("coerces enabled to boolean", async () => {
    await updateSettings({
      stremioAddons: [
        { id: "ggg77777", url: "https://example.com", name: "Test", enabled: 1 as unknown as boolean },
      ],
    });
    const s = getSettings();
    expect(s.stremioAddons[0]!.enabled).toBe(true);
  });

  it("filters out invalid entries while keeping valid ones in mixed array", async () => {
    await updateSettings({
      stremioAddons: [
        { id: "hhh88888", url: "https://valid.example.com", name: "Valid", enabled: true },
        { id: "", url: "https://no-id.example.com", name: "No ID", enabled: true },
        { id: "iii99999", url: "not-a-url", name: "Bad URL", enabled: false },
      ],
    });
    const s = getSettings();
    // Only the first (valid) entry survives
    expect(s.stremioAddons).toHaveLength(1);
    expect(s.stremioAddons[0]!.id).toBe("hhh88888");
  });

  it("proxyEnabled.stremio defaults to false", () => {
    const s = getSettings();
    expect(s.proxyEnabled.stremio).toBe(false);
  });

  it("proxyEnabled.stremio partial-merges correctly", async () => {
    await updateSettings({ proxyEnabled: { stremio: true } });
    const s = getSettings();
    expect(s.proxyEnabled.stremio).toBe(true);
    // Other proxy flags unaffected
    expect(s.proxyEnabled.yts).toBe(false);
    expect(s.proxyEnabled.knaben).toBe(false);
  });

  it("proxyEnabled partial-merge preserves stremio when updating other flags", async () => {
    await updateSettings({ proxyEnabled: { stremio: true } });
    await updateSettings({ proxyEnabled: { yts: true } });
    const s = getSettings();
    expect(s.proxyEnabled.stremio).toBe(true);
    expect(s.proxyEnabled.yts).toBe(true);
  });
});
