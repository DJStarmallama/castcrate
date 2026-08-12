/**
 * torrentday-fetch.ts — HTTP client for the TorrentDay adapter.
 *
 * Branches on `config.vpnMode`:
 *
 *   `vpn` | `off` — direct `fetch()` (undici) with optional Dispatcher.
 *                   Byte-identical to the pre-v2 codepath in torrentday.ts.
 *
 *   `torrentday-only` — spawn `ip netns exec castcrate-ns node
 *                       /opt/castcrate/scripts/td-fetcher.js <url>` per fetch;
 *                       cookies via env (never argv, never logged). Response
 *                       body flows back through the subprocess stdout.
 *
 * `config.vpnMode` is read at call time (not module init) so tests can rebind
 * the mocked config between cases.
 *
 * SECURITY / LOGGING
 * ------------------
 * - Cookies are passed to the subprocess via env (`TD_UID`, `TD_PASS`) — never
 *   via argv (visible in `ps`), never logged.
 * - Spawn log line: `torrentday: subprocess fetch → ns` — no URL, no cookies.
 * - Failure log line: `torrentday: subprocess exit=<code> <stderr-first-line>`
 *   — stderr class only (redirect/http/timeout/network), not cookie material.
 * - Under `torrentday-only`, if a Dispatcher is passed we emit a one-time warn
 *   log noting the dispatcher is ignored (subprocess uses stdlib https). See
 *   implementation.md Decision 6.
 */

import { spawn } from "node:child_process";
import type { Dispatcher, RequestInit as UndiciRequestInit } from "undici";
import { config } from "../lib/config.js";
import { TorrentDayAuthError } from "./torrentday-errors.js";

// Absolute paths — matches what the ns-wrapped subprocess runs on the deploy
// box. On macOS dev these paths do not exist; the caller must be in `off`
// mode (which uses `fetch()`) or the spawn will fail with ENOENT and the
// test suite mocks `child_process.spawn` to avoid touching them.
const IP_BIN = "/usr/sbin/ip";
const NODE_BIN = "/usr/bin/node";
const NS_NAME = "castcrate-ns";
const TD_FETCHER_PATH = "/opt/castcrate/scripts/td-fetcher.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const INNER_TIMEOUT_MS = 15_000;
/** Outer guard — 20s > 15s inner timeout. If the subprocess itself hangs past
 *  the inner timeout (event-loop stuck, kernel weirdness), the parent SIGKILLs
 *  it. Belt-and-braces per implementation.md Decision 9. */
const OUTER_TIMEOUT_MS = 20_000;

// One-time warn latch — the parent process emits at most one line about the
// dispatcher being ignored, no matter how many TD fetches happen in v2 mode.
let warnedDispatcherIgnored = false;

// ---------------------------------------------------------------------------
// Public API — used by torrentday.ts
// ---------------------------------------------------------------------------

/** Fetch a URL and return the body decoded as UTF-8 (for HTML pages). */
export async function fetchTdHtml(
  url: string,
  uid: string,
  pass: string,
  dispatcher: Dispatcher | undefined,
): Promise<string> {
  const buf = await fetchTdBytes(url, uid, pass, dispatcher);
  return buf.toString("utf8");
}

/** Fetch a URL and return the body as a raw Buffer (for `.torrent` blobs). */
export async function fetchTdBytes(
  url: string,
  uid: string,
  pass: string,
  dispatcher: Dispatcher | undefined,
): Promise<Buffer> {
  if (config.vpnMode === "torrentday-only") {
    if (dispatcher && !warnedDispatcherIgnored) {
      warnedDispatcherIgnored = true;
      console.warn(
        "torrentday: proxy dispatcher configured but ignored under VPN_MODE=torrentday-only (subprocess uses stdlib HTTPS)",
      );
    }
    return fetchViaSubprocess(url, uid, pass);
  }
  return fetchViaDirect(url, uid, pass, dispatcher);
}

/** Test-only: reset the one-time warn latch between cases. */
export function __resetTorrentDayFetchWarnLatchForTests(): void {
  warnedDispatcherIgnored = false;
}

// ---------------------------------------------------------------------------
// Direct fetch (vpn / off modes)
// ---------------------------------------------------------------------------

function buildHeaders(uid: string, pass: string): Record<string, string> {
  return {
    Cookie: `uid=${uid}; pass=${pass}`,
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml",
  };
}

async function fetchViaDirect(
  url: string,
  uid: string,
  pass: string,
  dispatcher: Dispatcher | undefined,
): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: buildHeaders(uid, pass),
      signal: AbortSignal.timeout(INNER_TIMEOUT_MS),
      redirect: "manual",
      dispatcher,
    } as UndiciRequestInit as unknown as RequestInit);
  } catch (err) {
    throw new Error(`TorrentDay fetch failed: ${(err as Error).message}`);
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "";
    if (location.includes("login")) {
      console.warn("torrentday: auth failed — refresh cookies");
      throw new TorrentDayAuthError();
    }
    throw new Error(`TorrentDay unexpected redirect to ${location}`);
  }

  if (!res.ok) {
    throw new Error(`TorrentDay HTTP ${res.status}`);
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------------------------------------------------------------------------
// Subprocess fetch (torrentday-only mode)
// ---------------------------------------------------------------------------

async function fetchViaSubprocess(
  url: string,
  uid: string,
  pass: string,
): Promise<Buffer> {
  // Log intent — no URL, no cookies. Cookies live in env; URL might expose a
  // search query to logs, which is not a security concern but is noise.
  console.info("torrentday: subprocess fetch → ns");

  return new Promise<Buffer>((resolveP, rejectP) => {
    const child = spawn(
      IP_BIN,
      ["netns", "exec", NS_NAME, NODE_BIN, TD_FETCHER_PATH, url],
      {
        // Scoped env — no full parent env passthrough. Limits inherited env
        // size and prevents unrelated app env from bleeding into the fetcher.
        env: {
          PATH: "/usr/bin:/usr/sbin",
          TD_UID: uid,
          TD_PASS: pass,
          TD_UA: UA,
          TD_TIMEOUT_MS: String(INNER_TIMEOUT_MS),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Outer guard — SIGKILL if the subprocess hangs past OUTER_TIMEOUT_MS.
    const outerTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore — already dead
      }
      settle(() =>
        rejectP(new Error("TorrentDay fetch failed: subprocess hung (outer timeout)")),
      );
    }, OUTER_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(outerTimer);
      settle(() =>
        rejectP(
          new Error(`TorrentDay fetch failed: spawn ${(err as Error).message}`),
        ),
      );
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(outerTimer);
      const stderrLine = stderr.split(/\r?\n/, 1)[0] ?? "";

      if (code === 0) {
        settle(() => resolveP(Buffer.concat(stdoutChunks)));
        return;
      }

      // Log the class only — no cookies, no URL.
      console.warn(`torrentday: subprocess exit=${code} ${stderrLine}`);

      switch (code) {
        case 20: {
          // 3xx to /login → auth error (matches direct-fetch codepath).
          settle(() => rejectP(new TorrentDayAuthError()));
          return;
        }
        case 21: {
          // stderrLine is "http <status>"; extract for a familiar-looking error.
          const m = /^http (\d+)$/.exec(stderrLine);
          const status = m ? m[1] : "unknown";
          settle(() => rejectP(new Error(`TorrentDay HTTP ${status}`)));
          return;
        }
        case 22: {
          settle(() => rejectP(new Error("TorrentDay fetch failed: timeout")));
          return;
        }
        case 23:
        default: {
          const detail = stderrLine || `exit ${code}`;
          settle(() =>
            rejectP(new Error(`TorrentDay fetch failed: ${detail}`)),
          );
          return;
        }
      }
    });
  });
}
