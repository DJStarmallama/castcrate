/**
 * config.ts env-parsing tests — focused on VPN_MODE's three-way parser plus
 * the defensive default. The module reads process.env at import time, so each
 * case must set env, use vi.resetModules(), then dynamic-import config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadConfig(): Promise<typeof import("../config.js").config> {
  vi.resetModules();
  const mod = await import("../config.js");
  return mod.config;
}

beforeEach(() => {
  // Wipe any prior VPN_MODE to isolate each case.
  delete process.env.VPN_MODE;
});

afterEach(() => {
  // Restore whatever env was live at test-file load.
  process.env = { ...ORIGINAL_ENV };
});

describe("config — VPN_MODE parsing", () => {
  it("VPN_MODE=vpn → vpnMode:'vpn'", async () => {
    process.env.VPN_MODE = "vpn";
    const c = await loadConfig();
    expect(c.vpnMode).toBe("vpn");
  });

  it("VPN_MODE=torrentday-only → vpnMode:'torrentday-only'", async () => {
    process.env.VPN_MODE = "torrentday-only";
    const c = await loadConfig();
    expect(c.vpnMode).toBe("torrentday-only");
  });

  it("VPN_MODE=off → vpnMode:'off'", async () => {
    process.env.VPN_MODE = "off";
    const c = await loadConfig();
    expect(c.vpnMode).toBe("off");
  });

  it("VPN_MODE unset → vpnMode:'off' (default)", async () => {
    // beforeEach already deleted it.
    const c = await loadConfig();
    expect(c.vpnMode).toBe("off");
  });

  it("VPN_MODE=garbage → vpnMode:'off' (defensive default)", async () => {
    process.env.VPN_MODE = "yes-please";
    const c = await loadConfig();
    expect(c.vpnMode).toBe("off");
  });

  it("VPN_MODE=td-only alias is NOT accepted (exact-literal only)", async () => {
    process.env.VPN_MODE = "td-only";
    const c = await loadConfig();
    expect(c.vpnMode).toBe("off");
  });

  it("VPN_MODE=VPN uppercase is NOT accepted (case-sensitive)", async () => {
    process.env.VPN_MODE = "VPN";
    const c = await loadConfig();
    expect(c.vpnMode).toBe("off");
  });
});
