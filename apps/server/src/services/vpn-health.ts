import { spawn } from "node:child_process";
import type { VpnHealth } from "@castcrate/shared";
import { config } from "../lib/config.js";

/** URL of the public-IP lookup. Called from inside the netns; naturally exits
 *  via the WG tunnel. Fixed 3s timeout.
 *
 *  Cloudflare's cdn-cgi/trace endpoint returns plain-text key=value lines
 *  and does NOT rate-limit VPN exit IPs (unlike ifconfig.co, which silently
 *  drops requests from certain commercial-VPN ranges — verified live against
 *  IPVanish's Amsterdam exit on 2026-08-12). */
const PROBE_URL = "https://1.1.1.1/cdn-cgi/trace";
const PROBE_TIMEOUT_MS = 3_000;
/** Absolute path — matches what systemd sees. On macOS dev the binary is
 *  absent and `spawn` will ENOENT; we catch that below and return `null`. */
const WG_BIN = "/usr/bin/wg";
const WG_TIMEOUT_MS = 1_000;
const CACHE_TTL_MS = 30_000;

// Subprocess paths for the torrentday-only probe path. Absolute — match what
// systemd invokes on the deploy box.
const IP_BIN = "/usr/sbin/ip";
const NODE_BIN = "/usr/bin/node";
const NS_NAME = "castcrate-ns";
const NS_FETCHER_PATH = "/opt/castcrate/scripts/ns-fetcher.js";
/** Outer guard for the probe subprocess — a bit longer than the inner
 *  NS_TIMEOUT_MS to catch the pathological case of the subprocess hanging. */
const PROBE_OUTER_TIMEOUT_MS = 5_000;

interface CacheEntry {
  value: VpnHealth;
  storedAt: number;
}

let cache: CacheEntry | null = null;

/**
 * Return a `VpnHealth` snapshot. Cached for 30s; `forceRefresh` bypasses.
 *
 * Behaviour by mode:
 *  - `off` / `unknown`: short-circuit to a static `mode:"off"` response — no
 *    network, no subprocess. macOS-dev / opt-out path.
 *  - `vpn` (v1): direct `fetch()` of the probe URL. Fastify is already inside
 *    `castcrate-ns`, so the fetch naturally exits via WG.
 *  - `torrentday-only` (v2): Fastify is on the host, so we spawn
 *    `ip netns exec castcrate-ns node /opt/castcrate/scripts/ns-fetcher.js
 *    <probe-url>` and parse the trace body from stdout. `wg show` is also
 *    wrapped with `ip netns exec castcrate-ns` since the WG interface lives
 *    inside the ns.
 *
 * Failed probes do NOT overwrite a valid cache — the caller gets a fresh
 * failure result and the previous success remains cached until it expires
 * naturally.
 */
export async function getVpnHealth(forceRefresh = false): Promise<VpnHealth> {
  // Off / unknown short-circuit — no network, no subprocess. Verified via test mock.
  if (config.vpnMode === "off" || config.vpnMode === "unknown") {
    return {
      mode: "off",
      publicIp: null,
      country: null,
      wgPeer: null,
      reachable: true,
      leaking: false,
      lastCheckedAt: null,
    };
  }

  if (!forceRefresh && cache && Date.now() - cache.storedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  const useNs = config.vpnMode === "torrentday-only";
  const [probe, wgPeer] = await Promise.all([
    useNs ? probePublicIpViaNs() : probePublicIp(),
    readWgPeer(useNs),
  ]);

  const modeOut = config.vpnMode; // "vpn" | "torrentday-only"

  if (!probe.ok) {
    // Failure — return fresh failure, do NOT touch the cache.
    return {
      mode: modeOut,
      publicIp: null,
      country: null,
      wgPeer,
      reachable: false,
      leaking: false,
      lastCheckedAt: null,
    };
  }

  const leaking =
    config.hostClearnetIp !== null && probe.publicIp === config.hostClearnetIp;

  const value: VpnHealth = {
    mode: modeOut,
    publicIp: probe.publicIp,
    country: probe.country,
    wgPeer,
    reachable: true,
    leaking,
    lastCheckedAt: Date.now(),
  };
  cache = { value, storedAt: Date.now() };
  return value;
}

type ProbeResult =
  | { ok: true; publicIp: string; country: string | null }
  | { ok: false };

/** Parse Cloudflare's `cdn-cgi/trace` body — newline-separated key=value pairs.
 *  Returns `{ ok: false }` when `ip=` is missing or empty. */
function parseTraceBody(body: string): ProbeResult {
  const kv = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    kv.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const ip = kv.get("ip");
  if (!ip || ip.length === 0) return { ok: false };
  const loc = kv.get("loc");
  const country = loc && loc.length > 0 ? loc.toUpperCase() : null;
  return { ok: true, publicIp: ip, country };
}

async function probePublicIp(): Promise<ProbeResult> {
  try {
    const res = await fetch(PROBE_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false };
    const body = await res.text();
    return parseTraceBody(body);
  } catch (err) {
    // Timeout / DNS / network — one warn line matches the codebase's existing
    // "log then move on" style. Do not include the URL in the log; the class
    // of failure is what matters.
    console.warn(`vpn-health: probe failed (${(err as Error).message})`);
    return { ok: false };
  }
}

/**
 * Under `torrentday-only` mode, Fastify runs on the host — a direct `fetch()`
 * would report the host's clearnet IP instead of the tunnel exit. Spawn
 * `ns-fetcher.js` inside `castcrate-ns` and parse the same trace body from
 * stdout.
 */
async function probePublicIpViaNs(): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolveP) => {
    const child = spawn(
      IP_BIN,
      ["netns", "exec", NS_NAME, NODE_BIN, NS_FETCHER_PATH, PROBE_URL],
      {
        env: {
          PATH: "/usr/bin:/usr/sbin",
          NS_TIMEOUT_MS: String(PROBE_TIMEOUT_MS),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stdoutChunks: Buffer[] = [];
    let stderrFirstLine = "";
    let settled = false;
    const done = (v: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolveP(v);
    };

    const outerTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      console.warn("vpn-health: probe failed (subprocess hung)");
      done({ ok: false });
    }, PROBE_OUTER_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(outerTimer);
      console.warn(
        `vpn-health: probe failed (spawn ${(err as Error).message})`,
      );
      done({ ok: false });
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!stderrFirstLine) {
        const s = chunk.toString("utf8");
        const nl = s.indexOf("\n");
        stderrFirstLine = nl >= 0 ? s.slice(0, nl) : s;
      }
    });
    child.on("close", (code) => {
      clearTimeout(outerTimer);
      if (code !== 0) {
        console.warn(
          `vpn-health: probe failed (subprocess exit=${code} ${stderrFirstLine})`,
        );
        done({ ok: false });
        return;
      }
      const body = Buffer.concat(stdoutChunks).toString("utf8");
      done(parseTraceBody(body));
    });
  });
}

/**
 * Best-effort read of `wg show wg-castcrate endpoints`. Returns the
 * `host:port` from the first non-empty line's second whitespace-delimited
 * field (`<pubkey>\t<host:port>`). Returns null on ENOENT (macOS dev), any
 * non-zero exit, timeout, empty output, or parse failure.
 *
 * The peer host:port is the same information the user already has from their
 * VPN provider — safe to expose. The peer public key is NOT read or logged.
 *
 * When `useNs` is true (torrentday-only mode), the `wg` invocation is wrapped
 * with `ip netns exec castcrate-ns` because Fastify is on the host but the
 * WG interface lives inside the ns. Under `vpn` mode Fastify is inside the
 * ns already; the direct `wg` invocation works.
 */
function readWgPeer(useNs = false): Promise<string | null> {
  return new Promise((resolveP) => {
    let child;
    try {
      if (useNs) {
        child = spawn(
          IP_BIN,
          ["netns", "exec", NS_NAME, WG_BIN, "show", "wg-castcrate", "endpoints"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      } else {
        child = spawn(WG_BIN, ["show", "wg-castcrate", "endpoints"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch {
      resolveP(null);
      return;
    }

    let stdout = "";
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolveP(v);
    };

    const to = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      done(null);
    }, WG_TIMEOUT_MS);

    child.on("error", () => {
      clearTimeout(to);
      done(null);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(to);
      if (code !== 0) {
        done(null);
        return;
      }
      const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      if (!line) {
        done(null);
        return;
      }
      const parts = line.trim().split(/\s+/);
      // Format: "<pubkey>\t<host:port>". Second field is the endpoint.
      // A peer with no active endpoint prints "(none)" — treat as null.
      const endpoint = parts[1];
      if (!endpoint || endpoint === "(none)") {
        done(null);
        return;
      }
      done(endpoint);
    });
  });
}

/** Test-only: reset the module-level cache between cases. */
export function __resetVpnHealthCacheForTests(): void {
  cache = null;
}
