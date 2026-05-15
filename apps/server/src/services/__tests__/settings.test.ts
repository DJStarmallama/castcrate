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
