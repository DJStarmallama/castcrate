/**
 * torrentday-fetch.ts branching tests.
 *
 * Verifies the vpnMode gate:
 *   - `off` / `vpn` — direct fetch, spawn NEVER called
 *   - `torrentday-only` — spawn called with the exact expected argv + env
 *     (cookies via env only, NOT argv), correctly maps exit codes 20/22 to
 *     TorrentDayAuthError / timeout, and preserves binary bytes end-to-end
 *
 * Strategy:
 *   - Mock `node:child_process` `spawn` so we can inspect argv + env without
 *     ever executing a real subprocess (spawn returns a Readable/EventEmitter
 *     stub we control).
 *   - Mock `config.vpnMode` at the module level; flip it per case.
 *   - `fetch` is stubbed via `vi.stubGlobal` on cases that need the direct
 *     path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// -----------------------------------------------------------------------------
// Mocks — declared before importing the module under test.
// -----------------------------------------------------------------------------

vi.mock("../../lib/config.js", () => ({
  config: {
    vpnMode: "off" as "vpn" | "torrentday-only" | "off" | "unknown",
  },
}));

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// -----------------------------------------------------------------------------
// Test doubles for spawn — a tiny ChildProcess-shaped object.
// -----------------------------------------------------------------------------

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

/**
 * Drive a fake spawn to completion — emits stdout, stderr, and close in the
 * order that matches Node's real child_process behaviour.
 */
function completeFakeChild(
  child: FakeChild,
  opts: { stdout?: Buffer | string; stderr?: string; code: number },
): void {
  // Micro-task the writes/close so the caller's `.on()` handlers register first.
  setImmediate(() => {
    if (opts.stdout !== undefined) {
      child.stdout.write(
        typeof opts.stdout === "string" ? Buffer.from(opts.stdout) : opts.stdout,
      );
    }
    if (opts.stderr) {
      child.stderr.write(opts.stderr);
    }
    child.stdout.end();
    child.stderr.end();
    // Small delay so any 'data' listener drains before 'close' fires.
    setImmediate(() => child.emit("close", opts.code));
  });
}

// -----------------------------------------------------------------------------
// Import after mocks.
// -----------------------------------------------------------------------------
import {
  fetchTdHtml,
  fetchTdBytes,
  __resetTorrentDayFetchWarnLatchForTests,
} from "../torrentday-fetch.js";
import { TorrentDayAuthError } from "../torrentday-errors.js";
import { config } from "../../lib/config.js";

const fetchMock = vi.fn();

beforeEach(() => {
  spawnMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  __resetTorrentDayFetchWarnLatchForTests();
  (config as { vpnMode: string }).vpnMode = "off";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// -----------------------------------------------------------------------------
// Case A — vpnMode=off uses direct fetch; spawn NOT called.
// -----------------------------------------------------------------------------
describe("torrentday-fetch — vpnMode=off / vpn", () => {
  it("uses direct fetch when vpnMode='off'; spawn is NOT called", async () => {
    (config as { vpnMode: string }).vpnMode = "off";
    const html = "<html>hi</html>";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () =>
        new TextEncoder().encode(html).buffer as ArrayBuffer,
    } as unknown as Response);

    const out = await fetchTdHtml(
      "https://www.torrentday.com/t?q=x",
      "uid-abc",
      "pass-xyz",
      undefined,
    );

    expect(out).toBe(html);
    expect(spawnMock).not.toHaveBeenCalled();
    // Direct-fetch path uses `fetch()`.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.torrentday.com/t?q=x");
    const headers = init.headers as Record<string, string>;
    expect(headers.Cookie).toBe("uid=uid-abc; pass=pass-xyz");
  });

  it("uses direct fetch when vpnMode='vpn'; spawn is NOT called (byte-identical to off)", async () => {
    (config as { vpnMode: string }).vpnMode = "vpn";
    const html = "<html>vpn-mode</html>";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () =>
        new TextEncoder().encode(html).buffer as ArrayBuffer,
    } as unknown as Response);

    const out = await fetchTdHtml(
      "https://www.torrentday.com/t?q=y",
      "uid",
      "pass",
      undefined,
    );

    expect(out).toBe(html);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Case B — vpnMode=torrentday-only spawns with expected argv + env.
// -----------------------------------------------------------------------------
describe("torrentday-fetch — vpnMode=torrentday-only", () => {
  it("spawns ip netns exec castcrate-ns node td-fetcher.js <url> with cookies in env (not argv)", async () => {
    (config as { vpnMode: string }).vpnMode = "torrentday-only";
    const html = "<html>hi from ns</html>";
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    completeFakeChild(child, { stdout: html, code: 0 });

    const out = await fetchTdHtml(
      "https://www.torrentday.com/t?q=inception",
      "uid-secret-42",
      "pass-secret-99",
      undefined,
    );

    expect(out).toBe(html);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(bin).toBe("/usr/sbin/ip");
    expect(args).toEqual([
      "netns",
      "exec",
      "castcrate-ns",
      "/usr/bin/node",
      "/opt/castcrate/scripts/td-fetcher.js",
      "https://www.torrentday.com/t?q=inception",
    ]);
    // Cookies MUST appear in env — proves the auth path is wired.
    expect(opts.env.TD_UID).toBe("uid-secret-42");
    expect(opts.env.TD_PASS).toBe("pass-secret-99");
    // Cookies MUST NOT appear anywhere in argv (visible in `ps`).
    for (const a of args) {
      expect(a).not.toContain("uid-secret-42");
      expect(a).not.toContain("pass-secret-99");
    }
  });

  // -----------------------------------------------------------------------------
  // Case C — subprocess exit 20 → TorrentDayAuthError.
  // -----------------------------------------------------------------------------
  it("subprocess exit 20 → TorrentDayAuthError", async () => {
    (config as { vpnMode: string }).vpnMode = "torrentday-only";
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    completeFakeChild(child, {
      stderr: "redirect:/login.php\n",
      code: 20,
    });

    await expect(
      fetchTdHtml("https://www.torrentday.com/t?q=x", "u", "p", undefined),
    ).rejects.toBeInstanceOf(TorrentDayAuthError);
  });

  // -----------------------------------------------------------------------------
  // Case D — subprocess exit 22 → error with "timeout".
  // -----------------------------------------------------------------------------
  it("subprocess exit 22 → error message contains 'timeout'", async () => {
    (config as { vpnMode: string }).vpnMode = "torrentday-only";
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    completeFakeChild(child, { stderr: "timeout\n", code: 22 });

    await expect(
      fetchTdHtml("https://www.torrentday.com/t?q=x", "u", "p", undefined),
    ).rejects.toThrow(/timeout/);
  });

  // -----------------------------------------------------------------------------
  // Case E — binary safety: stdout bytes are returned as Buffer, byte-identical.
  // -----------------------------------------------------------------------------
  it("subprocess stdout > 100 bytes starting with 0x64 → returned as Buffer byte-for-byte", async () => {
    (config as { vpnMode: string }).vpnMode = "torrentday-only";
    // Construct a fake .torrent-shaped buffer that MUST survive round-trip.
    const head = Buffer.from([0x64]); // 'd'
    const rand = Buffer.from(
      Array.from({ length: 500 }, (_, i) => (i * 37) & 0xff),
    );
    const tail = Buffer.from([0x65]); // 'e'
    const body = Buffer.concat([head, rand, tail]);

    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    completeFakeChild(child, { stdout: body, code: 0 });

    const out = await fetchTdBytes(
      "https://www.torrentday.com/download.php/xxx/foo.torrent",
      "u",
      "p",
      undefined,
    );

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBe(body.length);
    expect(out.equals(body)).toBe(true);
    expect(out[0]).toBe(0x64);
  });

  // -----------------------------------------------------------------------------
  // Bonus — subprocess exit 21 (non-2xx / non-3xx) → HTTP <status>.
  // -----------------------------------------------------------------------------
  it("subprocess exit 21 → error 'TorrentDay HTTP <status>'", async () => {
    (config as { vpnMode: string }).vpnMode = "torrentday-only";
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    completeFakeChild(child, { stderr: "http 429\n", code: 21 });

    await expect(
      fetchTdHtml("https://www.torrentday.com/t?q=x", "u", "p", undefined),
    ).rejects.toThrow(/TorrentDay HTTP 429/);
  });

  // -----------------------------------------------------------------------------
  // Dispatcher-ignored one-time warn.
  // -----------------------------------------------------------------------------
  it("emits a one-time warn when a dispatcher is passed under torrentday-only; subprocess still runs (dispatcher ignored)", async () => {
    (config as { vpnMode: string }).vpnMode = "torrentday-only";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);
      completeFakeChild(child, { stdout: "<html>ok</html>", code: 0 });

      const fakeDispatcher = {} as import("undici").Dispatcher;
      await fetchTdHtml(
        "https://www.torrentday.com/t?q=x",
        "u",
        "p",
        fakeDispatcher,
      );

      // Second call — warn latch prevents a second log line.
      const child2 = makeFakeChild();
      spawnMock.mockReturnValueOnce(child2);
      completeFakeChild(child2, { stdout: "<html>ok2</html>", code: 0 });
      await fetchTdHtml(
        "https://www.torrentday.com/t?q=y",
        "u",
        "p",
        fakeDispatcher,
      );

      const dispatcherWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("proxy dispatcher configured but ignored"),
      );
      expect(dispatcherWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
