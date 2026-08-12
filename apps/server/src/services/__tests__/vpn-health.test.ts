/**
 * vpn-health service tests.
 *
 * Strategy:
 * - Mock `../../lib/config.js` so each suite can flip `vpnMode` and
 *   `hostClearnetIp` without touching env.
 * - Mock global `fetch` so we can assert call count (cache behaviour) and
 *   inject success / failure / timeout responses.
 * - Do NOT mock `wg show` — the spawn call ENOENTs on macOS dev / CI where
 *   `/usr/bin/wg` is absent, and the service catches that and returns null.
 *   All tests therefore assert `wgPeer: null`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/config.js", () => ({
  config: {
    vpnMode: "off" as "vpn" | "off" | "unknown",
    hostClearnetIp: null as string | null,
  },
}));

import { config } from "../../lib/config.js";
import { getVpnHealth, __resetVpnHealthCacheForTests } from "../vpn-health.js";

const fetchMock = vi.fn();
// Silence the single `console.warn` on probe failure — expected in the
// timeout case; we don't want the test output polluted.
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  fetchMock.mockReset();
  warnSpy.mockClear();
  __resetVpnHealthCacheForTests();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Reset config defaults each test.
  (config as { vpnMode: "vpn" | "off" | "unknown" }).vpnMode = "off";
  (config as { hostClearnetIp: string | null }).hostClearnetIp = null;
});

/** Build a Cloudflare trace-format text body from ip + optional loc. */
function traceBody(ip: string, loc?: string): string {
  const lines = [
    "fl=abc123",
    "h=1.1.1.1",
    `ip=${ip}`,
    "ts=1700000000.000",
    "visit_scheme=https",
    "uag=node",
    "colo=AMS",
    "http=http/2",
  ];
  if (loc) lines.push(`loc=${loc}`);
  return lines.join("\n") + "\n";
}

function mockFetchOk(body: string) {
  fetchMock.mockResolvedValue({
    ok: true,
    text: async () => body,
  } as unknown as Response);
}

describe("vpn-health — probe cases", () => {
  it("mode=vpn, non-leaking response → reachable + leaking:false + uppercased country", async () => {
    (config as { vpnMode: "vpn" | "off" | "unknown" }).vpnMode = "vpn";
    (config as { hostClearnetIp: string | null }).hostClearnetIp = "5.6.7.8";
    mockFetchOk(traceBody("1.2.3.4", "de"));

    const h = await getVpnHealth();

    expect(h.mode).toBe("vpn");
    expect(h.publicIp).toBe("1.2.3.4");
    expect(h.country).toBe("DE");
    expect(h.reachable).toBe(true);
    expect(h.leaking).toBe(false);
    expect(h.wgPeer).toBeNull();
    expect(typeof h.lastCheckedAt).toBe("number");
  });

  it("mode=vpn, publicIp matches hostClearnetIp → leaking:true", async () => {
    (config as { vpnMode: "vpn" | "off" | "unknown" }).vpnMode = "vpn";
    (config as { hostClearnetIp: string | null }).hostClearnetIp = "5.6.7.8";
    mockFetchOk(traceBody("5.6.7.8", "us"));

    const h = await getVpnHealth();

    expect(h.leaking).toBe(true);
    expect(h.reachable).toBe(true);
    expect(h.publicIp).toBe("5.6.7.8");
    expect(h.country).toBe("US");
    expect(h.wgPeer).toBeNull();
  });

  it("mode=vpn, fetch rejects with AbortError → reachable:false, leaking:false", async () => {
    (config as { vpnMode: "vpn" | "off" | "unknown" }).vpnMode = "vpn";
    (config as { hostClearnetIp: string | null }).hostClearnetIp = "5.6.7.8";
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValue(abortErr);

    const h = await getVpnHealth();

    expect(h.reachable).toBe(false);
    expect(h.leaking).toBe(false);
    expect(h.publicIp).toBeNull();
    expect(h.country).toBeNull();
    expect(h.lastCheckedAt).toBeNull();
    expect(h.wgPeer).toBeNull();
  });

  it("mode=off → short-circuit; fetch is NOT called", async () => {
    (config as { vpnMode: "vpn" | "off" | "unknown" }).vpnMode = "off";

    const h = await getVpnHealth();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h).toEqual({
      mode: "off",
      publicIp: null,
      country: null,
      wgPeer: null,
      reachable: true,
      leaking: false,
      lastCheckedAt: null,
    });
  });
});

describe("vpn-health — caching", () => {
  it("second call within TTL hits cache; forceRefresh bypasses", async () => {
    (config as { vpnMode: "vpn" | "off" | "unknown" }).vpnMode = "vpn";
    (config as { hostClearnetIp: string | null }).hostClearnetIp = "5.6.7.8";
    mockFetchOk(traceBody("1.2.3.4", "de"));

    await getVpnHealth();
    await getVpnHealth();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await getVpnHealth(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
