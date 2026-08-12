#!/usr/bin/env node
/**
 * ns-fetcher.js — Purpose-restricted twin of td-fetcher.js. Spawned inside
 * `castcrate-ns` by vpn-health.ts under VPN_MODE=torrentday-only to probe
 * `https://1.1.1.1/cdn-cgi/trace` from within the tunnel.
 *
 * PURPOSE LOCK
 * ------------
 * ONLY use this for PUBLIC UNAUTHENTICATED URLs. It sends no Cookie header
 * and does not read TD_UID / TD_PASS. If you need authenticated fetches, use
 * `td-fetcher.js` instead — do NOT extend this script with an auth path
 * (that would silently give any misconfigured caller a way to bypass the
 * cookie-required invariant of td-fetcher.js).
 *
 * If you find yourself reaching for this script for a second use case, stop
 * and either (a) confirm the URL is public + unauthenticated + safe from
 * SSRF, or (b) extract a properly-designed shared helper. The lack of auth
 * makes this script an SSRF surface if it's ever handed a user-controlled URL.
 *
 * On the deploy box this file lives at `/opt/castcrate/scripts/ns-fetcher.js`;
 * the parent (`apps/server/src/services/vpn-health.ts`) spawns it with an
 * absolute path — never rely on $PATH resolution.
 *
 * IMPLEMENTATION
 * --------------
 * Same stdlib-only contract as td-fetcher.js. Zero npm dependencies.
 * Binary-safe stdout (though the trace endpoint returns plain text).
 * Same exit-code contract (0, 2, 20, 21, 22, 23). No `3` (missing-env) case
 * because there is no required env.
 *
 * USAGE
 * -----
 *   node ns-fetcher.js <absolute-url>
 *
 * ENV
 * ---
 *   NS_UA           — optional. User-Agent header. Defaults to a plain
 *                     "castcrate-ns-fetcher/1" identifier (this fetcher
 *                     doesn't impersonate a browser).
 *   NS_TIMEOUT_MS   — optional. Default 3000 (matches vpn-health probe
 *                     timeout).
 *
 * EXIT CODES
 * ----------
 *   0   — success (HTTP 2xx). Body bytes on stdout.
 *   2   — usage error (missing/extra argv).
 *   20  — HTTP 3xx redirect. Stderr: "redirect:<Location>".
 *   21  — HTTP non-2xx / non-3xx. Stderr: "http <status>".
 *   22  — request timeout. Stderr: "timeout".
 *   23  — network / socket error. Stderr: "network <errno-or-message>".
 */

"use strict";

const https = require("node:https");
const http = require("node:http");
const process = require("node:process");
const { URL } = require("node:url");

const DEFAULT_UA = "castcrate-ns-fetcher/1";
const DEFAULT_TIMEOUT_MS = 3000;

function usage() {
  process.stderr.write("usage: ns-fetcher.js <url>\n");
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
  process.stderr.write("network invalid-url\n");
  process.exit(23);
}
if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
  process.stderr.write("network bad-scheme\n");
  process.exit(23);
}

const ua = process.env.NS_UA || DEFAULT_UA;
const timeoutMs = (() => {
  const raw = process.env.NS_TIMEOUT_MS;
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
    "User-Agent": ua,
    Accept: "*/*",
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

  if (status >= 300 && status < 400) {
    const loc = res.headers.location || "";
    process.stderr.write(`redirect:${loc}\n`);
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
  process.stderr.write(`network ${err.code || err.message || "error"}\n`);
  finish(23);
});

req.setTimeout(timeoutMs, () => {
  process.stderr.write("timeout\n");
  try {
    req.destroy();
  } catch (_e) {
    // ignore
  }
  finish(22);
});

req.end();
