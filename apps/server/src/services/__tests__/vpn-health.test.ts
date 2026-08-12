/**
 * vpn-health service tests.
 *
 * Strategy:
 * - Mock `../../lib/config.js` so each suite can flip `vpnMode` and
 *   `hostClearnetIp` without touching env.
 * - Mock global `fetch` so we can assert call count (cache behaviour) and
 *   inject success / failure / timeout responses.
 * - Mock `node:child_process` `spawn` so the `torrentday-only` cases can
 *   simulate ns-fetcher.js output + exit code without touching a real ns.
 *   The direct-fetch cases (`vpn` mode) DO NOT touch spawn — `wg show`
 *   ENOENTs on macOS dev where `/usr/bin/wg` is absent, and the service
 *   catches that and returns null. Under `torrentday-only` the spawn mock
 *   controls both `ip netns exec … node ns-fetcher.js` and
 *   `ip netns exec … wg show`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("../../lib/config.js", () => ({
  config: {
    vpnMode: "off" as "vpn" | "torrentday-only" | "off" | "unknown",
    hostClearnetIp: null as string | null,
  },
}));

// spawn mock — installed but returns a real spawn-shaped stub only when the
// test wants to intercept. Default behaviour: delegate to the real spawn so
// existing macOS-ENOENT-based `wg show` cases still return null.
const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import { spawn as realSpawn } from "node:child_process";
import { config } from "../../lib/config.js";
import { getVpnHealth, __resetVpnHealthCacheForTests } from "../vpn-health.js";

const fetchMock = vi.fn();
// Silence the single `console.warn` on probe failure — expected in the
// timeout case; we don't want the test output polluted.
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

type Mode = "vpn" | "torrentday-only" | "off" | "unknown";
type ConfigShape = { vpnMode: Mode; hostClearnetIp: string | null };

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (sig?: string) => boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

function completeFakeChild(
  child: FakeChild,
  opts: { stdout?: Buffer | string; stderr?: string; code: number },
): void {
  setImmediate(() => {
    if (opts.stdout !== undefined) {
      child.stdout.write(
        typeof opts.stdout === "string" ? Buffer.from(opts.stdout) : opts.stdout,
      );
    }
    if (opts.stderr) child.stderr.write(opts.stderr);
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit("close", opts.code));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  warnSpy.mockClear();
  __resetVpnHealthCacheForTests();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Reset config defaults each test.
  (config as ConfigShape).vpnMode = "off";
  (config as ConfigShape).hostClearnetIp = null;
  // Default spawn behaviour: delegate to the real spawn (macOS `wg` binary
  // is absent so ENOENT flows through cleanly). Individual tests re-mock.
  spawnMock.mockReset();
  spawnMock.mockImplementation((...args: unknown[]) =>
    (realSpawn as unknown as (...a: unknown[]) => unknown)(...args),
  );
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
    (config as ConfigShape).vpnMode = "vpn";
    (config as ConfigShape).hostClearnetIp = "5.6.7.8";
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
    (config as ConfigShape).vpnMode = "vpn";
    (config as ConfigShape).hostClearnetIp = "5.6.7.8";
    mockFetchOk(traceBody("5.6.7.8", "us"));

    const h = await getVpnHealth();

    expect(h.leaking).toBe(true);
    expect(h.reachable).toBe(true);
    expect(h.publicIp).toBe("5.6.7.8");
    expect(h.country).toBe("US");
    expect(h.wgPeer).toBeNull();
  });

  it("mode=vpn, fetch rejects with AbortError → reachable:false, leaking:false", async () => {
    (config as ConfigShape).vpnMode = "vpn";
    (config as ConfigShape).hostClearnetIp = "5.6.7.8";
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

  it("mode=off → short-circuit; fetch is NOT called; spawn is NOT called", async () => {
    (config as ConfigShape).vpnMode = "off";

    const h = await getVpnHealth();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
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

  it("mode=unknown → short-circuit (same shape as off)", async () => {
    (config as ConfigShape).vpnMode = "unknown";

    const h = await getVpnHealth();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(h.mode).toBe("off");
    expect(h.reachable).toBe(true);
    expect(h.leaking).toBe(false);
  });
});

describe("vpn-health — caching", () => {
  it("second call within TTL hits cache; forceRefresh bypasses", async () => {
    (config as ConfigShape).vpnMode = "vpn";
    (config as ConfigShape).hostClearnetIp = "5.6.7.8";
    mockFetchOk(traceBody("1.2.3.4", "de"));

    await getVpnHealth();
    await getVpnHealth();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await getVpnHealth(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// -----------------------------------------------------------------------------
// Phase 5 — torrentday-only mode probing via subprocess.
// -----------------------------------------------------------------------------
describe("vpn-health — torrentday-only mode", () => {
  it("mode=torrentday-only, ns-fetcher returns trace body → {mode:'torrentday-only', publicIp, country, reachable}", async () => {
    (config as ConfigShape).vpnMode = "torrentday-only";
    (config as ConfigShape).hostClearnetIp = "5.6.7.8";

    // Route both spawns (ns-fetcher probe + `wg show` inside ns) through
    // our fake children. Order is deterministic — `Promise.all([probe, wg])`
    // creates the promises left-to-right, so probe spawns first.
    const probeChild = makeFakeChild();
    const wgChild = makeFakeChild();
    spawnMock
      .mockReturnValueOnce(probeChild)
      .mockReturnValueOnce(wgChild);
    completeFakeChild(probeChild, {
      stdout: traceBody("1.2.3.4", "nl"),
      code: 0,
    });
    completeFakeChild(wgChild, {
      stdout: "abcpubkey\t203.0.113.5:51820\n",
      code: 0,
    });

    const h = await getVpnHealth();

    expect(h.mode).toBe("torrentday-only");
    expect(h.publicIp).toBe("1.2.3.4");
    expect(h.country).toBe("NL");
    expect(h.reachable).toBe(true);
    expect(h.leaking).toBe(false);
    expect(h.wgPeer).toBe("203.0.113.5:51820");
    expect(typeof h.lastCheckedAt).toBe("number");
    // Fetch must NOT have been called — probe went through subprocess.
    expect(fetchMock).not.toHaveBeenCalled();
    // Both spawns issued.
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("mode=torrentday-only, ns-fetcher exits non-zero → {reachable:false, publicIp:null}", async () => {
    (config as ConfigShape).vpnMode = "torrentday-only";

    const probeChild = makeFakeChild();
    const wgChild = makeFakeChild();
    spawnMock
      .mockReturnValueOnce(probeChild)
      .mockReturnValueOnce(wgChild);
    completeFakeChild(probeChild, { stderr: "timeout\n", code: 22 });
    completeFakeChild(wgChild, { code: 1 }); // wg show also fails cleanly

    const h = await getVpnHealth();

    expect(h.mode).toBe("torrentday-only");
    expect(h.reachable).toBe(false);
    expect(h.publicIp).toBeNull();
    expect(h.country).toBeNull();
    expect(h.leaking).toBe(false);
    expect(h.wgPeer).toBeNull();
    expect(h.lastCheckedAt).toBeNull();
  });

  it("mode=torrentday-only, publicIp === HOST_CLEARNET_IP → leaking:true", async () => {
    (config as ConfigShape).vpnMode = "torrentday-only";
    (config as ConfigShape).hostClearnetIp = "5.6.7.8";

    const probeChild = makeFakeChild();
    const wgChild = makeFakeChild();
    spawnMock
      .mockReturnValueOnce(probeChild)
      .mockReturnValueOnce(wgChild);
    // Probe returns HOST clearnet IP — leak signal.
    completeFakeChild(probeChild, {
      stdout: traceBody("5.6.7.8", "us"),
      code: 0,
    });
    completeFakeChild(wgChild, { code: 1 });

    const h = await getVpnHealth();

    expect(h.mode).toBe("torrentday-only");
    expect(h.leaking).toBe(true);
    expect(h.reachable).toBe(true);
    expect(h.publicIp).toBe("5.6.7.8");
  });

  it("mode=torrentday-only, wg show spawn is wrapped with `ip netns exec castcrate-ns`", async () => {
    (config as ConfigShape).vpnMode = "torrentday-only";

    const probeChild = makeFakeChild();
    const wgChild = makeFakeChild();
    spawnMock
      .mockReturnValueOnce(probeChild)
      .mockReturnValueOnce(wgChild);
    completeFakeChild(probeChild, {
      stdout: traceBody("1.2.3.4"),
      code: 0,
    });
    completeFakeChild(wgChild, {
      stdout: "pubkey\t1.2.3.4:51820\n",
      code: 0,
    });

    await getVpnHealth();

    // Inspect the two spawn calls. Call 0 = probe. Call 1 = wg show.
    const call0 = spawnMock.mock.calls[0] as unknown as [string, string[]];
    const call1 = spawnMock.mock.calls[1] as unknown as [string, string[]];

    expect(call0[0]).toBe("/usr/sbin/ip");
    expect(call0[1].slice(0, 3)).toEqual(["netns", "exec", "castcrate-ns"]);
    expect(call0[1]).toContain("/opt/castcrate/scripts/ns-fetcher.js");

    // wg show is ALSO wrapped with `ip netns exec castcrate-ns` under v2.
    expect(call1[0]).toBe("/usr/sbin/ip");
    expect(call1[1]).toEqual([
      "netns",
      "exec",
      "castcrate-ns",
      "/usr/bin/wg",
      "show",
      "wg-castcrate",
      "endpoints",
    ]);
  });
});
