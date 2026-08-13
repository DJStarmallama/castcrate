/**
 * ns-fetcher.js behavioural tests — mirror of td-fetcher.test.ts, minus the
 * auth-required cases (ns-fetcher has no credential requirement).
 *
 * Strategy identical to td-fetcher: spin up a local `http.createServer` per
 * case, spawn the real script, inspect exit code + stdout + stderr.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const NS_FETCHER = resolve(HERE, "..", "..", "..", "..", "..", "scripts", "ns-fetcher.js");

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
    const child = spawn(process.execPath, [NS_FETCHER, ...args], {
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

describe("ns-fetcher.js", () => {
  it("argv missing → exit 2, usage on stderr, no HTTP request", async () => {
    const r = await runFetcher([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage:");
    expect(r.stdout.length).toBe(0);
  });

  it("200 with trace-format body → exit 0, stdout equals body bytes", async () => {
    const body = "fl=abc\nip=1.2.3.4\nloc=NL\n";
    await withServer(
      (req, res) => {
        // Verify the fetcher does NOT send a Cookie header — this is the
        // purpose-lock. Auth is td-fetcher's job.
        expect(req.headers.cookie).toBeUndefined();
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end(body);
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/cdn-cgi/trace`]);
        expect(r.code).toBe(0);
        expect(r.stdout.toString("utf8")).toBe(body);
      },
    );
  });

  it("200 with binary body → exit 0, stdout equals body byte-for-byte", async () => {
    const rand = randomBytes(2048);

    await withServer(
      (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(rand);
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/anything`]);
        expect(r.code).toBe(0);
        expect(r.stdout.length).toBe(rand.length);
        expect(r.stdout.equals(rand)).toBe(true);
      },
    );
  });

  it("302 with Location: /elsewhere → exit 20, stderr contains 'redirect:'", async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 302;
        res.setHeader("Location", "/elsewhere");
        res.end("");
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/foo`]);
        expect(r.code).toBe(20);
        expect(r.stderr).toContain("redirect:");
        expect(r.stderr).toContain("/elsewhere");
      },
    );
  });

  it("500 → exit 21, stderr contains 'http 500'", async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 500;
        res.end("boom");
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/foo`]);
        expect(r.code).toBe(21);
        expect(r.stderr).toContain("http 500");
      },
    );
  });

  it("socket close mid-response → exit 23, stderr starts with 'network'", async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 200;
        res.write("partial");
        res.socket?.destroy();
      },
      async (baseUrl) => {
        const r = await runFetcher([`${baseUrl}/foo`]);
        expect(r.code).toBe(23);
        expect(r.stderr).toMatch(/^network /);
      },
    );
  });

  it("connection refused (port 1) → exit 23, stderr starts with 'network'", async () => {
    const r = await runFetcher(["http://127.0.0.1:1/nope"]);
    expect(r.code).toBe(23);
    expect(r.stderr).toMatch(/^network /);
  });

  it("no credential env is required — script runs without TD_UID/TD_PASS", async () => {
    // Explicitly assert: even with TD_UID/TD_PASS unset, the fetcher works.
    // (Purpose-lock: ns-fetcher is authless by design.)
    const body = "ok";
    await withServer(
      (req, res) => {
        expect(req.headers.cookie).toBeUndefined();
        res.statusCode = 200;
        res.end(body);
      },
      async (baseUrl) => {
        // Explicitly wipe any auth env that might leak from the runner.
        const r = await runFetcher([`${baseUrl}/ping`], {
          TD_UID: "",
          TD_PASS: "",
        });
        expect(r.code).toBe(0);
        expect(r.stdout.toString("utf8")).toBe(body);
      },
    );
  });
});
