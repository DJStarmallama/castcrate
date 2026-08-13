/**
 * td-fetcher.js behavioural tests.
 *
 * Strategy:
 * - Spin up a local `http.createServer` per case (avoids TLS setup and keeps
 *   the fixture surface tiny). `td-fetcher.js` accepts `http://` URLs — the
 *   auth model uses cookies, not TLS.
 * - Spawn the real script as a subprocess and inspect exit code + stdout +
 *   stderr. This exercises the actual argv/env/stdout wiring that the parent
 *   Fastify process depends on.
 * - Every case explicitly re-asserts that no cookie material appears in
 *   stderr OR the combined output — the "no cookie leak" invariant is tested
 *   at every touch point, not just once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/td-fetcher.js lives at repo root: apps/server/src/scripts/__tests__/ → ../../../../../scripts
const TD_FETCHER = resolve(HERE, "..", "..", "..", "..", "..", "scripts", "td-fetcher.js");

const SECRET_UID = "test-uid-8a9d3f";
const SECRET_PASS = "test-pass-1e4b7c";

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

async function runFetcher(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolveP, reject) => {
    // Explicit scoped env — matches parent-side spawn shape.
    const child = spawn(process.execPath, [TD_FETCHER, ...args], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/usr/sbin", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outChunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveP({ code, stdout: Buffer.concat(outChunks), stderr: err });
    });
  });
}

/** Assert no cookie material appears anywhere in the observable output. */
function assertNoCookieLeak(res: RunResult) {
  const combined = res.stdout.toString("binary") + "\n" + res.stderr;
  expect(combined).not.toContain(SECRET_UID);
  expect(combined).not.toContain(SECRET_PASS);
  expect(combined).not.toContain(`uid=${SECRET_UID}`);
  expect(combined).not.toContain(`pass=${SECRET_PASS}`);
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer<T>(
  handler: Handler,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("td-fetcher.js", () => {
  it("argv missing → exit 2, usage on stderr, no HTTP request", async () => {
    const r = await runFetcher([], { TD_UID: SECRET_UID, TD_PASS: SECRET_PASS });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage:");
    expect(r.stdout.length).toBe(0);
    assertNoCookieLeak(r);
  });

  it("missing TD_UID env → exit 3, no HTTP request issued", async () => {
    // Server that would fail the test if it received any request.
    await withServer(
      (_req, res) => {
        res.statusCode = 500;
        res.end("should not be called");
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/anything`], {
          TD_PASS: SECRET_PASS,
          // TD_UID intentionally absent.
        });
        expect(r.code).toBe(3);
        expect(r.stderr).toContain("missing");
        expect(r.stdout.length).toBe(0);
        assertNoCookieLeak(r);
      },
    );
  });

  it("200 with small HTML body → exit 0, stdout equals body bytes", async () => {
    const html = "<html><body><table id='torrentTable'>ok</table></body></html>";
    await withServer(
      (req, res) => {
        // Verify the fetcher DID send the cookie header — proves auth path is wired.
        expect(req.headers.cookie).toBe(`uid=${SECRET_UID}; pass=${SECRET_PASS}`);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/t?q=test`], {
          TD_UID: SECRET_UID,
          TD_PASS: SECRET_PASS,
        });
        expect(r.code).toBe(0);
        expect(r.stdout.toString("utf8")).toBe(html);
        assertNoCookieLeak(r);
      },
    );
  });

  it("200 with binary .torrent body → exit 0, stdout equals body byte-for-byte", async () => {
    // Build a fake .torrent body: starts with 'd' (0x64) — bencode dict magic —
    // followed by cryptographic random bytes to prove binary safety end-to-end.
    const head = Buffer.from([0x64]);
    const rand = randomBytes(4096);
    const tail = Buffer.from([0x65]); // 'e' end of dict
    const body = Buffer.concat([head, rand, tail]);

    await withServer(
      (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-bittorrent");
        res.end(body);
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/download.php/xxx/foo.torrent`], {
          TD_UID: SECRET_UID,
          TD_PASS: SECRET_PASS,
        });
        expect(r.code).toBe(0);
        expect(r.stdout.length).toBe(body.length);
        expect(r.stdout.equals(body)).toBe(true);
        assertNoCookieLeak(r);
      },
    );
  });

  it("302 with Location: /login.php → exit 20, stderr contains 'redirect:'", async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 302;
        res.setHeader("Location", "/login.php");
        res.end("");
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/t?q=test`], {
          TD_UID: SECRET_UID,
          TD_PASS: SECRET_PASS,
        });
        expect(r.code).toBe(20);
        expect(r.stderr).toContain("redirect:");
        expect(r.stderr).toContain("/login.php");
        assertNoCookieLeak(r);
      },
    );
  });

  it("401 → exit 21, stderr contains 'http 401'", async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 401;
        res.end("nope");
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/t?q=test`], {
          TD_UID: SECRET_UID,
          TD_PASS: SECRET_PASS,
        });
        expect(r.code).toBe(21);
        expect(r.stderr).toContain("http 401");
        assertNoCookieLeak(r);
      },
    );
  });

  it("socket close mid-response → exit 23, stderr starts with 'network'", async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.write("<html>partial");
        // Yank the underlying socket — mid-response abort.
        res.socket?.destroy();
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/t?q=test`], {
          TD_UID: SECRET_UID,
          TD_PASS: SECRET_PASS,
        });
        expect(r.code).toBe(23);
        expect(r.stderr).toMatch(/^network /);
        assertNoCookieLeak(r);
      },
    );
  });

  it("connection refused (bad port) → exit 23, stderr 'network ECONNREFUSED'", async () => {
    // Port 1 is virtually guaranteed to refuse — nothing listens there.
    const r = await runFetcher(["http://127.0.0.1:1/nope"], {
      TD_UID: SECRET_UID,
      TD_PASS: SECRET_PASS,
    });
    expect(r.code).toBe(23);
    expect(r.stderr).toMatch(/^network /);
    // Do NOT assert the specific errno — kernels differ (ECONNREFUSED on Linux,
    // ECONNREFUSED on macOS, but some environments give EACCES for port 1).
    assertNoCookieLeak(r);
  });

  it("redaction: cookies never appear in argv (proved by no url substring match) or stderr on error", async () => {
    // Cross-check: even the URL fetch flow with a real body doesn't leak.
    const html = "<table id='torrentTable'>x</table>";
    await withServer(
      (_req, res) => {
        res.statusCode = 200;
        res.end(html);
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/t?q=cookies-are-not-in-argv`], {
          TD_UID: SECRET_UID,
          TD_PASS: SECRET_PASS,
        });
        expect(r.code).toBe(0);
        // Body integrity — the response IS on stdout.
        expect(r.stdout.toString("utf8")).toBe(html);
        // No cookie material bled into either stream.
        assertNoCookieLeak(r);
        // Also — stderr should be empty on the success path (no logging surface).
        expect(r.stderr).toBe("");
      },
    );
  });
});
