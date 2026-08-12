#!/usr/bin/env node
/**
 * td-fetcher.js — TorrentDay HTTP fetcher, spawned inside `castcrate-ns` by
 * Fastify (running on the host) under `VPN_MODE=torrentday-only`. Every TD
 * HTTP call (search HTML, `.torrent` blob download, health probe) invokes
 * this script per-URL; response body flows back to the parent over stdout.
 *
 * On the deploy box this file lives at `/opt/castcrate/scripts/td-fetcher.js`;
 * the parent (`apps/server/src/services/torrentday-fetch.ts`) spawns it with
 * an absolute path — never rely on $PATH resolution.
 *
 * SECURITY INVARIANTS
 * -------------------
 * - Cookies (`TD_UID`, `TD_PASS`) are read from env ONLY. Never accepted via
 *   argv (argv is visible in `ps`). Never logged in any form — stdout is body
 *   bytes; stderr is only an error class + short message (no cookie material,
 *   no URLs, no headers).
 * - Stdlib-only. Imports: `node:https`, `node:http`, `node:process`, `node:url`.
 *   Zero npm dependencies to eliminate supply-chain surface for the process
 *   that carries the TD session cookies.
 * - Binary-safe stdout: response bytes are piped raw (no `.toString('utf8')`
 *   anywhere). `.torrent` blobs are binary bencode; a stray utf8 decode
 *   corrupts them.
 *
 * USAGE
 * -----
 *   node td-fetcher.js <absolute-url>
 *
 * ENV (all read from `process.env`)
 * ---------------------------------
 *   TD_UID          — required. TorrentDay session `uid` cookie value.
 *   TD_PASS         — required. TorrentDay session `pass` cookie value.
 *   TD_UA           — optional. User-Agent header. Defaults to the same UA
 *                     string the in-process TD adapter uses; keep in sync
 *                     with `apps/server/src/services/torrentday.ts`.
 *   TD_TIMEOUT_MS   — optional. Request timeout in milliseconds. Default 15000
 *                     (matches the parent adapter's AbortSignal.timeout).
 *
 * EXIT CODES
 * ----------
 *   0   — success (HTTP 2xx). Body bytes on stdout.
 *   2   — usage error (missing/extra argv).
 *   3   — env error (missing TD_UID or TD_PASS).
 *   20  — HTTP 3xx redirect. Stderr: "redirect:<Location>". Parent maps to
 *         `TorrentDayAuthError` (a 3xx to `/login` is TD's auth-failure signal).
 *   21  — HTTP non-2xx / non-3xx. Stderr: "http <status>".
 *   22  — request timeout. Stderr: "timeout".
 *   23  — network / socket error (ECONNREFUSED, ENOTFOUND, socket-close mid-response, etc.).
 *         Stderr: "network <errno-or-message>".
 */

"use strict";

const https = require("node:https");
const http = require("node:http");
const process = require("node:process");
const { URL } = require("node:url");

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 15000;

function usage() {
  // Argv url is fine to reference in a usage line (no secret material).
  process.stderr.write("usage: td-fetcher.js <url>\n");
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.length !== 1) usage();
const rawUrl = argv[0];
if (!rawUrl || typeof rawUrl !== "string") usage();

let parsed;
try {
  parsed = new URL(rawUrl);
} catch (_err) {
  // Do not echo the offending URL — just the class of failure.
  process.stderr.write("network invalid-url\n");
  process.exit(23);
}
if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
  process.stderr.write("network bad-scheme\n");
  process.exit(23);
}

const uid = process.env.TD_UID;
const pass = process.env.TD_PASS;
if (!uid || !pass) {
  process.stderr.write("env missing TD_UID or TD_PASS\n");
  process.exit(3);
}

const ua = process.env.TD_UA || DEFAULT_UA;
const timeoutMs = (() => {
  const raw = process.env.TD_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
})();

const client = parsed.protocol === "https:" ? https : http;

const options = {
  method: "GET",
  hostname: parsed.hostname,
  port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
  path: `${parsed.pathname}${parsed.search || ""}`,
  headers: {
    Cookie: `uid=${uid}; pass=${pass}`,
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml",
  },
};

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  process.exit(code);
}

const req = client.request(options, (res) => {
  const status = res.statusCode || 0;

  // 3xx — TorrentDay redirects unauth'd requests to /login. The parent maps
  // exit=20 to TorrentDayAuthError, so we surface the Location for diagnosis
  // (Location is not secret — TD's public URL layout).
  if (status >= 300 && status < 400) {
    const loc = res.headers.location || "";
    process.stderr.write(`redirect:${loc}\n`);
    // Drain and dispose the body so the socket closes cleanly.
    res.resume();
    finish(20);
    return;
  }

  if (status < 200 || status >= 300) {
    process.stderr.write(`http ${status}\n`);
    res.resume();
    finish(21);
    return;
  }

  // Binary-safe pipe. `res.pipe(process.stdout)` preserves bytes; Node's
  // Writable applies backpressure naturally, so large .torrent blobs will
  // not overflow the pipe buffer.
  res.on("error", (err) => {
    process.stderr.write(`network ${err.code || err.message || "stream-error"}\n`);
    finish(23);
  });
  res.on("end", () => {
    finish(0);
  });
  res.pipe(process.stdout);
});

req.on("error", (err) => {
  // ECONNREFUSED, ENOTFOUND, ECONNRESET (socket close), etc.
  process.stderr.write(`network ${err.code || err.message || "error"}\n`);
  finish(23);
});

req.setTimeout(timeoutMs, () => {
  // Explicit "timeout" so the parent can map exit=22 → "TorrentDay fetch failed: timeout".
  process.stderr.write("timeout\n");
  try {
    req.destroy();
  } catch (_e) {
    // ignore — already destroyed
  }
  finish(22);
});

req.end();
