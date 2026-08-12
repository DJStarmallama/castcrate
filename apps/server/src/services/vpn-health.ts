import { spawn } from "node:child_process";
import type { VpnHealth } from "@castcrate/shared";
import { config } from "../lib/config.js";

/** URL of the public-IP lookup. Called from inside the netns; naturally exits
 *  via the WG tunnel. Fixed 3s timeout. */
const IFCONFIG_URL = "https://ifconfig.co/json";
const IFCONFIG_TIMEOUT_MS = 3_000;
/** Absolute path — matches what systemd sees. On macOS dev the binary is
 *  absent and `spawn` will ENOENT; we catch that below and return `null`. */
const WG_BIN = "/usr/bin/wg";
const WG_TIMEOUT_MS = 1_000;
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: VpnHealth;
  storedAt: number;
}

let cache: CacheEntry | null = null;

/**
 * Return a `VpnHealth` snapshot. Cached for 30s; `forceRefresh` bypasses.
 *
 * When `config.vpnMode !== "vpn"`, short-circuits to a static `mode:"off"`
 * response WITHOUT issuing the ifconfig.co fetch or spawning `wg` — this is
 * the macOS-dev / opt-out path and must never touch the network.
 *
 * Failed probes do NOT overwrite a valid cache — the caller gets a fresh
 * failure result and the previous success remains cached until it expires
 * naturally.
 */
export async function getVpnHealth(forceRefresh = false): Promise<VpnHealth> {
  // Off short-circuit — no network, no subprocess. Verified via test mock.
  if (config.vpnMode !== "vpn") {
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

  const [probe, wgPeer] = await Promise.all([probePublicIp(), readWgPeer()]);

  if (!probe.ok) {
    // Failure — return fresh failure, do NOT touch the cache.
    return {
      mode: "vpn",
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
    mode: "vpn",
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

async function probePublicIp(): Promise<ProbeResult> {
  try {
    const res = await fetch(IFCONFIG_URL, {
      signal: AbortSignal.timeout(IFCONFIG_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { ip?: unknown; country_iso?: unknown };
    if (typeof body.ip !== "string" || body.ip.length === 0) {
      return { ok: false };
    }
    const country =
      typeof body.country_iso === "string" && body.country_iso.length > 0
        ? body.country_iso.toUpperCase()
        : null;
    return { ok: true, publicIp: body.ip, country };
  } catch (err) {
    // Timeout / DNS / network — one warn line matches the codebase's existing
    // "log then move on" style. Do not include the URL in the log; the class
    // of failure is what matters.
    console.warn(`vpn-health: probe failed (${(err as Error).message})`);
    return { ok: false };
  }
}

/**
 * Best-effort read of `wg show wg-castcrate endpoints`. Returns the
 * `host:port` from the first non-empty line's second whitespace-delimited
 * field (`<pubkey>\t<host:port>`). Returns null on ENOENT (macOS dev), any
 * non-zero exit, timeout, empty output, or parse failure.
 *
 * The peer host:port is the same information the user already has from their
 * VPN provider — safe to expose. The peer public key is NOT read or logged.
 */
function readWgPeer(): Promise<string | null> {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(WG_BIN, ["show", "wg-castcrate", "endpoints"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
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
