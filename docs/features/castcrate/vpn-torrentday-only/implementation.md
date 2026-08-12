# vpn-torrentday-only — Implementation Plan

**Epic:** castcrate
**Status:** In Progress
**Started:** 2026-08-12
**Target Completion:** TBD
**Last Updated:** 2026-08-12 17:56

**Successor to:** `vpn-split-tunnel` (v1) — this is v2, coexisting three-mode.

---

## Executive Summary

Keep the `castcrate-ns` + WireGuard infrastructure from `vpn-split-tunnel` v1 but flip the routing model: Fastify runs on the HOST (clearnet) at full throughput, and only the TorrentDay adapter's HTTP calls are routed through the tunnel via a subprocess-in-ns pattern (`ip netns exec castcrate-ns node td-fetcher.js <url>`). WebTorrent peers, DHT, other indexers, metadata, subtitles, Chromecast, and LAN clients all use the host's native network path — recovering the ~250ms RTT + peer connectivity that v1's full-tunnel design cost. TorrentDay site access still works because TD's HTTP fetches take the tunnel; other sources (YTS/Knaben/Stremio) are unaffected. Adds `VPN_MODE=torrentday-only` as a new three-way value; `vpn` (v1) and `off` keep working unchanged.

---

## Goals

**Primary**
- Full clearnet peer throughput for WebTorrent (measurable, sustained ≥5 MB/s on well-seeded titles) while TorrentDay search + `.torrent` downloads still work with the box's system VPN off.
- Zero regressions on the two existing `VPN_MODE` values (`vpn`, `off`): both must produce byte-identical behaviour to what v1 shipped.
- TorrentDay adapter is the only consumer that needs to know about the subprocess pattern — every other adapter, service, and route stays untouched.

**Secondary**
- Reuse the existing `castcrate-netns.service`, `wg0.conf`, and `netns-up.sh` scaffolding. No duplicate infra, no second unit, no second veth pair.
- Fail-closed for the TD flow: if the WG peer is down, TD fetches error out (subprocess non-zero exit) while every other source continues to work on clearnet. Documented as intentional in `requirements.md`.
- Visible mode surface: settings dropdown + nav pill so the user knows which mode they're in.
- Zero credential leak surface: TD cookies are passed to the subprocess via env only (never argv, never log), and the subprocess process image is stdlib-only (no npm supply-chain surface).

---

## Architecture Overview

### v2 (`torrentday-only`) routing

```
                              ┌───────────────────────────────┐
                              │      WireGuard peer           │
                              │   (IPVanish / Mullvad / …)    │
                              └──────────────┬────────────────┘
                                             │  encrypted UDP
                                             │
   ─────────────────── HOST (default netns) ─┼──────────────────────────────
                                             │
   ┌──────────────┐          ┌───────────────┴────────────────┐
   │ LAN clients  │          │ Host eth0 / enp… (192.168.x.y) │
   │ + Chromecast │          │  (Fastify listens here)         │
   └──────┬───────┘          └────────────────┬────────────────┘
          │                                    │
          │ TCP :3000                          │ clearnet outbound
          ▼                                    ▼
   ┌────────────────────────────────────────────────────────────────┐
   │ Fastify (:3000)  — running on host, NO netns entry             │
   │                                                                 │
   │   • LAN UI serving                    ─── clearnet (native)     │
   │   • WebTorrent peers + DHT + tracker  ─── clearnet (native)     │
   │   • YTS / Knaben / Stremio HTTP       ─── clearnet (native)     │
   │   • OMDb / TMDB metadata              ─── clearnet (native)     │
   │   • OpenSubtitles / subtitle fetch    ─── clearnet (native)     │
   │   • Chromecast mDNS + castv2 ctrl     ─── clearnet (native)     │
   │                                                                 │
   │   • TorrentDay adapter fetch(url) ────┐                         │
   │     • spawn ip netns exec castcrate-ns│                         │
   │       node /opt/castcrate/scripts/    │                         │
   │       td-fetcher.js <url>             │                         │
   │     • cookies via env (TD_UID, TD_PASS)                        │
   │     • body → subprocess stdout → parent Buffer                  │
   └───────────────────────────────────────┼────────────────────────┘
                                           │
                                           ▼ (spawned subprocess)
   ┌────────────────────────────────────────────────────────────────┐
   │ CASTCRATE-NS                                                    │
   │                                                                 │
   │   ┌──────────────────────────┐                                  │
   │   │ wg-castcrate (WireGuard) │──── TD HTTP egress via tunnel ─▶ │
   │   │ from /etc/castcrate/     │                                  │
   │   │ wg0.conf                 │                                  │
   │   └──────────────────────────┘                                  │
   │                                                                 │
   │   • Default route via wg-castcrate                              │
   │   • Per-ns resolv.conf → 1.1.1.1 (via WG)                       │
   │   • NO veth pair (nothing needs LAN reachability from inside)   │
   │   • NO host DNAT (server isn't in the ns)                       │
   │   • NO FORWARD ACCEPT rules (nothing traverses the host)        │
   │                                                                 │
   │   node td-fetcher.js <url> runs here, exits when body flushed   │
   └────────────────────────────────────────────────────────────────┘
```

**Per-fetch flow (TD adapter):**
1. `torrentday.ts` builds URL + cookie pair as usual.
2. Instead of `fetch(url, { headers: { Cookie: ... } })`, spawn `ip netns exec castcrate-ns /usr/bin/node /opt/castcrate/scripts/td-fetcher.js <url>` with env `TD_UID`, `TD_PASS`, and optional `TD_MODE=head|body`.
3. Subprocess uses `node:https` (stdlib) to fetch, writes body bytes to stdout, exits 0 on 2xx or non-zero on error.
4. Parent reads stdout, converts to string (HTML) or `Buffer` (`.torrent` blob), passes to existing `parseSearchHtml()` / webtorrent as today.

### Contrast with v1

| Property | v1 (`vpn`) | v2 (`torrentday-only`) | `off` |
|---|---|---|---|
| Fastify process placement | inside `castcrate-ns` | on host | on host |
| `castcrate-netns.service` state | `active` — full setup | `active` — WG + resolv.conf only | `inactive` (ConditionPath skip) |
| veth pair | present | **absent** | absent |
| Host DNAT `:3000 → ns` | present | **absent** | absent |
| FORWARD ACCEPT rules | present | **absent** | absent |
| WG interface + default route in ns | present | present | absent |
| Per-ns resolv.conf | present | present | absent |
| All outbound VPN'd | yes | no — only TD | no |
| Torrent peer path | tunnel | clearnet | clearnet |
| TorrentDay reachable | yes (via tunnel) | yes (via subprocess) | no (blocked at TD) |
| Chromecast mDNS path | veth exception route | native (host) | native (host) |
| Fail-closed on WG drop | all egress fails | TD fails; rest OK | N/A |

**Key invariants (preserved from v1):**
- `wg-castcrate` still lives inside the ns. Host `eth0` default route untouched — SSH, monitoring, all unrelated processes unaffected.
- IPv6 stays disabled inside the ns.
- `wg0.conf` provider config, `HOST_CLEARNET_IP` env, `CASTCRATE_LAN_IP` env — semantics unchanged. (`CASTCRATE_LAN_IP` becomes unnecessary in v2 mode since Fastify runs on the host and `os.networkInterfaces()` sees real interfaces again — but keeping the env honoured is a no-op for v2 users and matters if they switch back to v1.)
- `/api/system/vpn-health` still probes the tunnel to prove it's up.

**Key changes:**
- `netns-up.sh` becomes mode-aware: reads `VPN_MODE` from env and skips the veth pair, DNAT, and FORWARD steps when mode is `torrentday-only`. Only WG + resolv.conf are configured.
- `run-server.sh` gains a third branch: `torrentday-only` behaves like `off` (exec node on host, no `ip netns exec` prefix).
- `torrentday.ts` gains a subprocess-based HTTP client used only when `config.vpnMode === "torrentday-only"`. Existing direct `fetch()` path stays for `vpn` and `off` (byte-identical to today).
- `vpn-health.ts` gains a subprocess-based probe path for `torrentday-only` mode (the current `fetch()` probe works for `vpn` mode because Fastify itself is in the ns; in v2 mode Fastify is on the host and needs to hop into the ns via the same td-fetcher pattern).

---

## Implementation Phases

Effort key: **S** ≤ 2h, **M** ≤ 1 day, **L** > 1 day.
Phases marked **[max-effort]** should be routed to an advanced dev agent by `/proceed` — they touch deploy units or the production box.

### Phase 1 — Extend `VpnMode` shared type + `config.ts` + `.env.example`

**Goal:** Add the new mode as a first-class value in the type system and env parsing. No runtime behaviour change yet — this phase is entirely unit-testable and lets every downstream phase reference `config.vpnMode === "torrentday-only"` cleanly.

**Effort:** S

**Tasks**
- [ ] Extend `packages/shared/src/index.ts`:
  - `VpnMode`: add `"torrentday-only"`. Full union becomes `"vpn" | "torrentday-only" | "off" | "unknown"`.
  - Update the JSDoc block on `VpnMode` to describe all three real modes (`off` / `vpn` / `torrentday-only`) with the one-line "what runs where" for each.
  - Update the JSDoc on `VpnHealth.mode` to note that in `torrentday-only` mode the probe reports the tunnel's exit IP (same as `vpn` mode) — the field describes *where the probe went*, not where the server runs.
- [ ] Extend `apps/server/src/lib/config.ts`:
  - Change the `vpnMode` initializer to accept three literal values (defaulting to `"off"` for anything else):
    ```ts
    const rawVpnMode = process.env.VPN_MODE ?? "off";
    const vpnMode = (rawVpnMode === "vpn" || rawVpnMode === "torrentday-only"
      ? rawVpnMode
      : "off") as VpnMode;
    ```
  - Update the JSDoc comment block on `vpnMode` to describe the three-mode semantics.
- [ ] Update `.env.example`:
  - Change `VPN_MODE` documentation to enumerate all three values with a one-line "pick this if…" for each.
- [ ] Unit test `apps/server/src/lib/__tests__/config.test.ts` (or extend the vpn-health tests):
  - `VPN_MODE=vpn` → `config.vpnMode === "vpn"`.
  - `VPN_MODE=torrentday-only` → `config.vpnMode === "torrentday-only"`.
  - `VPN_MODE=off` → `config.vpnMode === "off"`.
  - `VPN_MODE=unset` → `config.vpnMode === "off"`.
  - `VPN_MODE=garbage` → `config.vpnMode === "off"` (defensive).

**Files touched**
- `packages/shared/src/index.ts` (extend `VpnMode` union + JSDoc)
- `apps/server/src/lib/config.ts` (three-way parser + JSDoc)
- `.env.example` (three-mode docs)
- `apps/server/src/lib/__tests__/config.test.ts` (new or extended)

**Acceptance criteria**
- `pnpm typecheck` clean across `packages/shared`, `apps/server`, `apps/web`.
- New unit test covers all four env cases (three real + garbage).
- No runtime behaviour change: `torrentday-only` value is defined but nothing branches on it yet. Existing `getVpnHealth` still short-circuits on `vpnMode !== "vpn"` (so v2 mode currently reports `mode:"off"` from the health endpoint — Phase 5 fixes this).

---

### Phase 2 — Write `scripts/td-fetcher.js` (stdlib-only Node subprocess)

**Goal:** Land the small subprocess that will be invoked from inside the ns to fetch TD URLs. Standalone, testable outside the CastCrate context (`ip netns exec castcrate-ns node scripts/td-fetcher.js https://www.torrentday.com/t?q=inception` should work on the deploy box).

**Effort:** S

**Tasks**
- [ ] Create `scripts/td-fetcher.js`. Constraints:
  - Uses only `node:https`, `node:http`, `node:process`, `node:url` from stdlib. **No** imports from the workspace, **no** npm packages.
  - Argv shape: `node td-fetcher.js <url>`. Exactly one required arg; anything else prints usage to stderr and exits 2.
  - Env inputs (all read from `process.env`):
    - `TD_UID` (required for HTTP requests to TD; missing → exit 3).
    - `TD_PASS` (required; missing → exit 3).
    - `TD_UA` (optional; default: the same `Mozilla/5.0 …` UA string `torrentday.ts` currently uses — keep in sync).
    - `TD_TIMEOUT_MS` (optional; default `15000`, matching the existing adapter's `AbortSignal.timeout(15_000)`).
  - Behaviour:
    - HTTPS GET with `Cookie: uid=<TD_UID>; pass=<TD_PASS>`, `User-Agent: <TD_UA>`, `Accept: text/html,application/xhtml+xml`.
    - Follow **no** redirects (matches the current adapter's `redirect: "manual"` — a 3xx to `/login` is the auth-failure signal and needs to reach the parent).
    - On 2xx: pipe response bytes to `process.stdout`, exit 0 when the response ends.
    - On 3xx: write the `Location` header to stderr prefixed `redirect:`, exit 20. Parent maps `exit === 20` to `TorrentDayAuthError`.
    - On non-2xx / non-3xx: write `http <status>` to stderr, exit 21.
    - On timeout (`setTimeout` cancel + `req.destroy()`): stderr `timeout`, exit 22.
    - On network error (`ECONNREFUSED`, `ENOTFOUND`, etc.): stderr `network <code>`, exit 23.
  - **Never log secrets.** Never write `TD_UID`, `TD_PASS`, or the full Cookie header to stdout OR stderr. Only the status/error class. Argv URL is fine to log to stderr as part of a `usage` line but nothing more.
  - Binary safety: write raw bytes (`res.pipe(process.stdout)` — do not call `.toString('utf8')` because `.torrent` blobs are binary bencode).
  - `#!/usr/bin/env node` shebang. `chmod +x` in the repo so it can be invoked directly during debugging.
- [ ] Add a small Vitest unit test at `apps/server/src/scripts/__tests__/td-fetcher.test.ts` that spawns the script against a Vitest-managed local HTTP server (using `node:http.createServer`) and exercises:
  - 200 with a small HTML body → exit 0, stdout equals body bytes.
  - 200 with a binary `.torrent`-shaped Buffer (starts with `0x64` `d` bencode dict) → exit 0, stdout bytes equal server body byte-for-byte.
  - 302 with `Location: /login.php` → exit 20, stderr contains `redirect:`.
  - 401 → exit 21, stderr contains `http 401`.
  - Socket close mid-response → exit 23.
  - Missing `TD_UID` env → exit 3, no HTTP request issued.
  - Missing argv → exit 2.
  - **Redaction test:** search stderr + stdout combined for `TD_UID`/`TD_PASS` string values; must be absent.
- [ ] Add a repo-root `pnpm` script `test:td-fetcher` that runs just this suite (fast — no fixtures load).
- [ ] Note in the file header comment: this script's runtime location on the deploy box is `/opt/castcrate/scripts/td-fetcher.js`; parent invocations MUST pass this absolute path.

**Files touched**
- `scripts/td-fetcher.js` (new, executable)
- `apps/server/src/scripts/__tests__/td-fetcher.test.ts` (new)

**Acceptance criteria**
- 7-case Vitest suite passes (`pnpm --filter @castcrate/server test scripts/__tests__/td-fetcher.test.ts`).
- Redaction test explicitly confirms no cookie material appears in either stream.
- Script runs standalone on macOS dev via `node scripts/td-fetcher.js https://example.com` (no argv errors, just fetches example.com — dev-time sanity check).
- Script passes `shellcheck` is N/A (it's JS) — instead: `node --check scripts/td-fetcher.js` passes as part of Phase 4's CI check.

---

### Phase 3 — Route TD adapter fetches through the subprocess when mode is `torrentday-only`

**Goal:** Wire the new subprocess pattern into `torrentday.ts` behind a mode gate. Existing `vpn` / `off` paths remain byte-identical (direct `fetch()` as today).

**Effort:** M

**Tasks**
- [ ] Extract a small helper `apps/server/src/services/torrentday-fetch.ts` (new file — keeps `torrentday.ts` from ballooning):
  - Exports `fetchTdHtml(url: string, uid: string, pass: string, dispatcher: Dispatcher | undefined): Promise<string>` and `fetchTdBytes(url: string, uid: string, pass: string, dispatcher: Dispatcher | undefined): Promise<Buffer>`.
  - Reads `config.vpnMode` at call time (not module init) so tests can rebind config.
  - If `vpnMode !== "torrentday-only"`: uses the existing direct-fetch codepath (moved verbatim from `torrentday.ts` — 15s timeout, `redirect: "manual"`, cookie headers, dispatcher). No behaviour change vs today.
  - If `vpnMode === "torrentday-only"`: `spawn("/usr/sbin/ip", ["netns", "exec", "castcrate-ns", "/usr/bin/node", "/opt/castcrate/scripts/td-fetcher.js", url], { env: { PATH: "/usr/bin:/usr/sbin", TD_UID: uid, TD_PASS: pass, TD_UA: UA, TD_TIMEOUT_MS: "15000" }, stdio: ["ignore", "pipe", "pipe"] })`.
    - Collect stdout into a `Buffer[]` and concatenate on close (streaming into a running buffer is fine — `.torrent` blobs are small, HTML responses are ≤ a few hundred KB).
    - Reject via `TorrentDayAuthError` when exit code is 20 (matches the current 3xx-to-login path).
    - Reject via `Error("TorrentDay HTTP <status>")` when exit code is 21 (matches current `!res.ok` path).
    - Reject via `Error("TorrentDay fetch failed: timeout")` when exit code is 22.
    - Reject via `Error("TorrentDay fetch failed: <stderr>")` when exit code is 23 or unknown.
    - Parent-side timeout guard: 20s (a bit longer than the subprocess's own 15s) that `SIGKILL`s the child and rejects if the subprocess itself hangs.
    - Dispatcher is a no-op in the subprocess path — the ns default route already routes via WG, and the subprocess can't accept a `Dispatcher` object anyway. Emit a one-time `console.warn` if a dispatcher is passed while in v2 mode, so the coexistence surprise with `proxy-routing` is documented in logs (see Decision 6).
  - Never logs cookies or subprocess env. Log format on spawn: `torrentday: subprocess fetch → ns` (no URL, no cookies). Log format on failure: `torrentday: subprocess exit=<code> <stderr class>`.
- [ ] Update `apps/server/src/services/torrentday.ts`:
  - Replace the two `fetch(...)` call sites (in `fetchSearchHtml` and `fetchTorrentBlob`) with calls to `fetchTdHtml` / `fetchTdBytes`.
  - Keep the surrounding logic (cache keys, HTML parsing, bencode magic-byte validation, `TorrentDayAuthError` handling) unchanged.
  - The `dispatcher = getDispatcher("torrentday")` line stays for backward compat with `vpn` / `off` modes.
- [ ] Extend `apps/server/src/services/__tests__/torrentday.test.ts` (or add a sibling `torrentday-fetch.test.ts`):
  - Mock `child_process.spawn` (Vitest `vi.mock('node:child_process')`).
  - Case A (`vpnMode = "off"`): call `fetchTdHtml`; assert `spawn` was NOT called; assert `fetch` WAS called with the expected URL + headers.
  - Case B (`vpnMode = "torrentday-only"`): call `fetchTdHtml`; assert `spawn` was called with `/usr/sbin/ip netns exec castcrate-ns /usr/bin/node /opt/castcrate/scripts/td-fetcher.js <url>`; assert env contains `TD_UID` + `TD_PASS`; assert env does NOT contain them stringified in argv.
  - Case C (subprocess exit 20 → `TorrentDayAuthError`).
  - Case D (subprocess exit 22 → error with "timeout").
  - Case E (subprocess stdout > 100 bytes with `d` first byte → returned as Buffer to caller — proves binary safety).
- [ ] Update `apps/server/src/services/__tests__/vpn-health.test.ts` if it currently asserts `getVpnHealth` short-circuits on `vpnMode !== "vpn"` — it will need to accept `torrentday-only` as a "should probe" mode after Phase 5, but should still short-circuit on `off`. (Split the case.)

**Files touched**
- `apps/server/src/services/torrentday-fetch.ts` (new)
- `apps/server/src/services/torrentday.ts` (edit — swap `fetch()` sites)
- `apps/server/src/services/__tests__/torrentday-fetch.test.ts` (new)
- `apps/server/src/services/__tests__/torrentday.test.ts` (extend if existing test breaks)

**Acceptance criteria**
- Vitest suite grows to include the 5 new cases; all pass.
- With `VPN_MODE=off` on macOS dev, TorrentDay adapter behaviour is byte-identical to today (verified by re-running the existing torrentday test suite).
- With `VPN_MODE=torrentday-only`, `spawn` is invoked with the exact expected argv + env shape; cookies do not appear in argv.
- No new lint errors; typecheck clean.
- The subprocess path never receives the `dispatcher` — verified by the mock.

---

### Phase 4 — Extend `scripts/run-server.sh` + `scripts/netns-up.sh` for three-mode gating **[max-effort]**

**Goal:** Deploy scripts branch cleanly on the new mode. `run-server.sh` gets a third branch; `netns-up.sh` skips the veth/DNAT/FORWARD steps when the mode is `torrentday-only`. Both scripts remain idempotent and byte-identical for v1 (`vpn`) mode.

**Effort:** M — deploy-adjacent, touches security-critical script surface. Route to a max-effort dev agent.

Why max-effort: `run-server.sh` and `netns-up.sh` are executed by root systemd units on the production box. A regression here can silently VPN'd-the-wrong-thing or brick the deploy. The v1 tilde-footgun class of bugs (media-mac-deploy Bugs A/B/C) all lived in this exact file surface. Absolute paths only; every branch behaviour has to be verified with `bash -n` + shellcheck + a real invocation.

**Tasks**
- [ ] Edit `scripts/run-server.sh`:
  - Change the two-way gate to three-way:
    ```
    case "${VPN_MODE:-off}" in
      vpn)
        >&2 echo "[run-server] VPN_MODE=vpn → exec node inside castcrate-ns"
        exec /usr/sbin/ip netns exec castcrate-ns "$NODE" "$ENTRY"
        ;;
      torrentday-only)
        >&2 echo "[run-server] VPN_MODE=torrentday-only → exec node on host (TD adapter spawns into ns per-fetch)"
        exec "$NODE" "$ENTRY"
        ;;
      off|"")
        >&2 echo "[run-server] VPN_MODE=off → exec node on host (no ns)"
        exec "$NODE" "$ENTRY"
        ;;
      *)
        >&2 echo "[run-server] ERROR: unknown VPN_MODE=$VPN_MODE (must be vpn|torrentday-only|off)"
        exit 1
        ;;
    esac
    ```
  - Update the header comment to enumerate all three modes.
  - `bash -n scripts/run-server.sh` passes; `shellcheck` passes.
- [ ] Edit `scripts/netns-up.sh`:
  - Read `VPN_MODE` from env near the top (after preconditions, before Step 1). Define a boolean `NEED_LAN_BRIDGE`:
    ```
    VPN_MODE="${VPN_MODE:-off}"
    case "$VPN_MODE" in
      vpn) NEED_LAN_BRIDGE=1 ;;
      torrentday-only) NEED_LAN_BRIDGE=0 ;;
      *) die "netns-up.sh should not run for VPN_MODE=$VPN_MODE (systemd ConditionPathExists is the guard)"
         # Note: the guard is defence-in-depth. The unit file's
         # ConditionPathExists=/etc/castcrate/wg0.conf handles VPN_MODE=off
         # (config not deployed). If VPN_MODE=off but wg0.conf is present
         # from a previous mode, we still shouldn't set anything up.
         ;;
    esac
    log "VPN_MODE=$VPN_MODE (NEED_LAN_BRIDGE=$NEED_LAN_BRIDGE)"
    ```
  - Wrap Steps 4 (veth pair), 5 (veth address assignment), 9 (ip_forward — only needed by DNAT), 10 (DNAT), 11 (FORWARD ACCEPT) in `if [ "$NEED_LAN_BRIDGE" = 1 ]; then … fi`.
  - Steps 0 (resolv.conf), 1 (namespace create), 2 (IPv6 disable), 3 (loopback up), 6 (WG interface create + move), 7 (WG setconf + address), 8 (WG routing — needs re-scoping, see next task) remain unconditional.
  - Step 8 routing: the RFC1918 + multicast exception routes are only needed when something inside the ns needs to reach the LAN. In v2 mode nothing enters the ns from the LAN, and the only ns process (td-fetcher) only talks to torrentday.com (external). So the exception routes are skippable too. But: adding them anyway is harmless (they only apply if a process actually tries to reach RFC1918 from inside the ns, which td-fetcher will never do). YAGNI: skip them under `NEED_LAN_BRIDGE=0` to keep the ns config minimal and easier to reason about.
  - Update the `log` line at the end to print a mode-appropriate verification hint:
    - `vpn` mode: same as today (`curl inside ns → VPN IP; curl on host → home IP`).
    - `torrentday-only` mode: `node /opt/castcrate/scripts/td-fetcher.js https://1.1.1.1/cdn-cgi/trace via ip netns exec should show VPN IP`.
- [ ] Edit `scripts/netns-down.sh`:
  - No functional changes required — the guarded `if exists` checks already handle the case where veth/DNAT/FORWARD were never added. Verify by running teardown after a `torrentday-only` `netns-up.sh` and confirming zero errors (Phase 8 real-box test).
  - Add a header note acknowledging the down script is mode-agnostic (it just cleans up whatever's present).
- [ ] Edit `deploy/systemd/castcrate-netns.service`:
  - Add `EnvironmentFile=/home/castcrate/castcrate/apps/server/.env` so `VPN_MODE` reaches `netns-up.sh` at start. (Currently the unit has no `EnvironmentFile=`; `netns-up.sh` reads a raw env that would be empty under systemd.)
  - Alternative considered: `ExecStart=/usr/bin/env VPN_MODE=$(grep …) …` — rejected as brittle. `EnvironmentFile=` is the standard idiom.
  - Verify the file exists at unit-start time via `ConditionPathExists=` (already present for `wg0.conf`; consider adding one for the `.env` too — though this may over-constrain: users who set `VPN_MODE` via `Environment=` in a drop-in shouldn't be blocked. Skip; the unit will just see empty `VPN_MODE` and fall through to the `die` branch in `netns-up.sh`, which is loud + safe).
- [ ] Edit `deploy/systemd/castcrate.service`:
  - No functional change needed — `run-server.sh` already reads `VPN_MODE` from the `EnvironmentFile` that's already declared here.
  - Update the header comment to enumerate the three supported values.
- [ ] Verification on macOS dev (what's possible without a real ns):
  - `bash -n scripts/*.sh` — all pass.
  - Manual sanity: `VPN_MODE=torrentday-only bash -c 'source scripts/run-server.sh || true'` (with `NODE=/bin/echo` shim) — verify the correct branch echoes.
- [ ] Verification deferred to Phase 8 (real box):
  - `systemctl start castcrate-netns.service` with `VPN_MODE=torrentday-only` in the env file: `ip netns exec castcrate-ns ip link` shows only `lo` + `wg-castcrate` (no `veth-cc-ns`).
  - `iptables -t nat -L PREROUTING -n | grep 10.200.200.2` returns nothing (no DNAT rule).
  - `iptables -L FORWARD -n | grep 10.200.200.0/30` returns nothing.
  - `curl -s http://<box>:3000/api/ping` from the LAN returns 200 — Fastify is on the host, no DNAT needed.
  - `ip netns exec castcrate-ns /usr/bin/node /opt/castcrate/scripts/td-fetcher.js https://1.1.1.1/cdn-cgi/trace` returns Cloudflare's trace body with the WG exit IP.

**Files touched**
- `scripts/run-server.sh` (three-way gate)
- `scripts/netns-up.sh` (mode-aware skips)
- `scripts/netns-down.sh` (header comment only)
- `deploy/systemd/castcrate-netns.service` (add `EnvironmentFile=`)
- `deploy/systemd/castcrate.service` (header comment only)

**Acceptance criteria**
- `bash -n` passes on all three scripts.
- `shellcheck` passes on all three scripts (rerun in Phase 8 on Ubuntu).
- `run-server.sh` echoes distinct branch messages for each of the three real modes and errors out on unknown.
- `netns-up.sh` reads `VPN_MODE` and skips the veth/DNAT/FORWARD steps when the mode is `torrentday-only`.
- Existing `vpn` mode behaviour is byte-identical (verify by re-running `netns-up.sh` under `VPN_MODE=vpn` on macOS dev — same commands issued, no missing steps).
- Unit file changes are additive only (no removed directives).

---

### Phase 5 — Extend `vpn-health.ts` for `torrentday-only` mode

**Goal:** `/api/system/vpn-health` reports meaningful state in v2 mode. In v1 mode Fastify was inside the ns so `fetch(PROBE_URL)` naturally exited via WG; in v2 mode Fastify is on the host so a direct `fetch()` would report the *host clearnet IP*, not the tunnel exit. Use the same subprocess pattern as TD fetches.

**Effort:** S–M

**Tasks**
- [ ] Extend `apps/server/src/services/vpn-health.ts`:
  - Add a subprocess-based probe helper `probePublicIpViaNs(): Promise<ProbeResult>`:
    - Spawns `ip netns exec castcrate-ns /usr/bin/node /opt/castcrate/scripts/td-fetcher.js https://1.1.1.1/cdn-cgi/trace` with no `TD_UID` / `TD_PASS` env (the trace endpoint doesn't need auth — but `td-fetcher.js` currently `exit 3`s on missing creds).
    - **Design decision:** rather than special-case the fetcher, add a `TD_ALLOW_NO_AUTH=1` env flag that skips the credential check in `td-fetcher.js`. Only vpn-health probes should ever set this. Alternatively — and cleaner — extract a tiny separate `scripts/ns-fetcher.js` that's identical to td-fetcher.js but doesn't require credentials, and use it for the probe. **Chosen path:** extract `scripts/ns-fetcher.js` — one 30-line stdlib script, purpose-obvious name, no env-flag branching in a security-sensitive script. `td-fetcher.js` stays TD-purpose-locked.
  - Modify `getVpnHealth`:
    - Change the short-circuit condition from `config.vpnMode !== "vpn"` to `config.vpnMode === "off"`. Both `vpn` and `torrentday-only` now trigger probing.
    - When `config.vpnMode === "torrentday-only"`, use `probePublicIpViaNs()` (subprocess through ns) instead of `probePublicIp()` (direct fetch).
    - `wgPeer` reading — `wg show wg-castcrate endpoints` currently works because Fastify is inside the ns in v1 mode. In v2 mode Fastify is on the host and the `wg-castcrate` interface is inside the ns, so `wg show wg-castcrate endpoints` on the host will fail. Wrap `readWgPeer()` with an `ip netns exec castcrate-ns` prefix when `vpnMode === "torrentday-only"`. Preserve the ENOENT-tolerant + timeout behaviour.
    - `mode` field: return `"torrentday-only"` (not `"vpn"`) when in that mode. `leaking` semantics unchanged (compare `publicIp` vs `HOST_CLEARNET_IP`).
- [ ] Create `scripts/ns-fetcher.js`:
  - Purpose-restricted twin of `td-fetcher.js` — same stdlib-only implementation, same exit code contract, but:
    - No `TD_UID` / `TD_PASS` env requirement.
    - No `Cookie` header sent.
    - Otherwise identical: single URL argv, stdout body, timeout, exit codes.
    - Header comment explicitly notes: this is for vpn-health probes to public unauthenticated endpoints ONLY. If a caller needs auth, use `td-fetcher.js` instead.
- [ ] Extend `apps/server/src/services/__tests__/vpn-health.test.ts`:
  - Existing 5 cases: keep. Split the "off short-circuit" case into two: `off` still short-circuits, `unknown` still short-circuits (defensive default).
  - New case: `vpnMode === "torrentday-only"` + subprocess returns Cloudflare trace body with `ip=1.2.3.4\nloc=NL\n` → `getVpnHealth()` returns `{ mode: "torrentday-only", publicIp: "1.2.3.4", country: "NL", reachable: true, leaking: false, ... }`.
  - New case: `vpnMode === "torrentday-only"` + subprocess exits non-zero → `{ mode: "torrentday-only", reachable: false }`.
  - New case: `vpnMode === "torrentday-only"` + `publicIp === HOST_CLEARNET_IP` → `{ leaking: true }` (leak detection still works via the subprocess probe).
  - Add a test for `wg show` invocation being wrapped with `ip netns exec castcrate-ns` under `torrentday-only`.
- [ ] Add a test for `scripts/ns-fetcher.js` (mirror of the td-fetcher test cases, without the creds gating).

**Files touched**
- `apps/server/src/services/vpn-health.ts` (three-way mode branching)
- `scripts/ns-fetcher.js` (new)
- `apps/server/src/services/__tests__/vpn-health.test.ts` (extend)
- `apps/server/src/scripts/__tests__/ns-fetcher.test.ts` (new — mirrors td-fetcher tests)

**Acceptance criteria**
- Vitest suite grows to +3 new cases in vpn-health, +6 new cases in ns-fetcher; all pass.
- `getVpnHealth` returns `mode: "torrentday-only"` when in that mode, with a real `publicIp` from the subprocess probe.
- Leak detection works in v2 mode (probe returns host IP → `leaking: true`).
- macOS dev with `VPN_MODE=off` still short-circuits (no subprocess spawn) — verified by test mock.

---

### Phase 6 — UI: settings dropdown + nav pill label

**Goal:** Surface the new mode in the settings surface + the nav pill so the user can tell which mode is active. Backend-only would be enough for correctness, but the pill is the security-visible surface that tells the user "am I VPN'd or not".

**Effort:** S

**Tasks**
- [ ] Extend `apps/web/src/components/Settings.tsx` "Network / VPN" section:
  - The section currently renders read-only state from `vpnHealth`. For v2 we add a small explainer subsection above the badge:
    - **Header:** "VPN mode"
    - **Body:** three-line explainer showing which mode the server is in + a one-line "this means…" for each. Sourced from the `vpnMode` field on `GET /api/settings` (already surfaced in v1 via `apps/server/src/routes/health.ts`).
    - **`torrentday-only` case:** "Fastify on host; TorrentDay adapter routes through VPN. Peers full-throughput; TD site reachable."
    - **`vpn` case:** "Full-tunnel — all server egress via VPN. Peer throughput reduced."
    - **`off` case:** existing explainer stays.
  - The setting itself is read-only from the UI (server-side env var); we do NOT expose a dropdown to switch modes from the UI — mode changes require a `systemctl restart castcrate castcrate-netns` on the box. Add a one-line hint: "To change mode, edit `VPN_MODE=` in `/home/castcrate/castcrate/apps/server/.env` and `sudo systemctl restart castcrate castcrate-netns`."
  - Confirm the mode badge (green/red/amber/grey) still makes sense for `torrentday-only` — same rules apply: green when reachable + not leaking; red on leak; amber on unreachable. The existing badge code should Just Work once `getVpnHealth` returns `mode: "torrentday-only"` — but verify the CSS class picker doesn't have a `mode === "vpn"` special case.
- [ ] Extend `apps/web/src/components/VpnStatusPill.tsx`:
  - Add the new label mapping per requirements:
    - `mode === "vpn" && !leaking && reachable` → `VPN · <XX>` (green, existing)
    - `mode === "torrentday-only" && !leaking && reachable` → `TD-only · <XX>` (green, **new**)
    - `mode === "off"` → `OFF` (grey, existing)
    - `leaking` → `LEAK` (red, existing)
    - `!reachable` → `?` (amber, existing)
  - The label max-width may need bumping for `TD-only · XX` (11 chars) — measure against the existing `VPN · XX` (7 chars). Tailwind width classes: use `max-w-[8rem]` or auto-width; verify against the existing nav layout.
  - Update the pill's aria-label to describe the new mode: "TorrentDay-only VPN active, exit country XX" or similar.
- [ ] Extend `.env.example` `VPN_MODE` docs (already touched in Phase 1 — verify final wording covers the "pick this if…" tri-fold guidance from requirements Phase 8).
- [ ] No new client tests — the web package has no `test` script (verified in v1 Phase 5 context). Manual browser verification (Phase 8) is the acceptance path.

**Files touched**
- `apps/web/src/components/Settings.tsx` (mode explainer subsection)
- `apps/web/src/components/VpnStatusPill.tsx` (add `TD-only · XX` label + aria)
- `.env.example` (final wording — already touched in Phase 1)

**Acceptance criteria**
- `pnpm --filter @castcrate/web typecheck` clean.
- With mocked `vpnHealth` returning `mode: "torrentday-only"`, the pill shows `TD-only · XX` in green.
- Settings section shows the mode-appropriate explainer.
- Existing `vpn` and `off` labels + explainers unchanged (regression check via manual browser toggle of `VPN_MODE` on dev).

---

### Phase 7 — Runbook update in `media-mac-deploy` Phase 8

**Goal:** Fold the deploy story into the existing runbook so a future re-deploy picks up the three-mode understanding and knows to drop `td-fetcher.js` + `ns-fetcher.js` alongside the existing scripts.

**Effort:** S

**Tasks**
- [ ] Update `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 8:
  - Rewrite the intro paragraph to explain the three-mode `VPN_MODE` choice:
    - `off` — no VPN routing (macOS local dev; also for users who don't want VPN at all).
    - `vpn` — full-tunnel (v1); every outbound request goes via WG. Highest privacy; lowest peer throughput.
    - `torrentday-only` — split (v2); Fastify on host, only TD adapter routes via WG. Full peer throughput; loses full-tunnel privacy.
  - Add a "pick this if…" guide:
    - `off`: you only stream from public sources (YTS, Knaben) and don't care about hiding your torrent-tracker IP.
    - `vpn`: you want maximum privacy for all outbound (trackers, indexers, metadata, subtitles). Accept ~250ms RTT + reduced peer throughput.
    - `torrentday-only`: you use TorrentDay and want full peer throughput. Trades outbound-metadata privacy for download speed.
  - Update the copy-file step to include `td-fetcher.js` + `ns-fetcher.js`:
    ```
    sudo cp scripts/netns-up.sh scripts/netns-down.sh scripts/run-server.sh \
            scripts/td-fetcher.js scripts/ns-fetcher.js \
            /opt/castcrate/scripts/
    sudo chmod +x /opt/castcrate/scripts/*.{sh,js}
    ```
  - Update the `.env` step to show setting `VPN_MODE=torrentday-only` as an example alternative to `VPN_MODE=vpn`.
  - Add a v2-specific verification step: with `VPN_MODE=torrentday-only`:
    - `ip netns exec castcrate-ns /usr/bin/node /opt/castcrate/scripts/td-fetcher.js https://www.torrentday.com/t?q=inception TD_UID=... TD_PASS=...` returns HTML (test-only invocation using ephemeral shell env).
    - `ss -tlnp | grep :3000` shows the node process bound to the host (not inside the ns).
    - Trigger a TD search from the UI → non-empty results.
    - Measure peer throughput on a known-good torrent: `curl -s http://localhost:3000/api/torrent/status/<hash> | jq .downloadSpeed` shows sustained ≥5 MB/s.
    - Kill-switch spot-check specific to v2: `wg-quick down` inside ns → TD search fails cleanly; other-source searches (YTS) continue to work.
- [ ] Cross-link back from `vpn-torrentday-only/context.md` (created during work) to `media-mac-deploy/tasks.md` for the deploy steps.

**Files touched**
- `docs/features/castcrate/media-mac-deploy/tasks.md` (update Phase 8)
- `docs/features/castcrate/vpn-torrentday-only/context.md` (will be created during work)

**Acceptance criteria**
- Runbook Phase 8 documents all three modes with a "pick this if…" guide.
- Copy-file step includes both new JS scripts.
- v2-specific verification steps are checkable.

---

### Phase 8 — Real-box execution + throughput measurement **[max-effort]**

**Goal:** Deploy the three-mode gate to the actual 2011 MBP box. Switch to `VPN_MODE=torrentday-only`, verify TD still works, measure peer throughput improvement vs v1. Close the DoD.

**Effort:** M — production box, deploy-adjacent, non-reversible if we bork the systemd units. Route to a max-effort dev agent.

Why max-effort: same concerns as v1 Phase 7 — SSH lockout risk, tilde-footgun surface, tcpdump-based observability. Additionally: needs to compare-measure throughput before/after, which requires a controlled test on a known-good torrent.

**Tasks**
- [ ] **Pre-flight on the deployed box (still under `VPN_MODE=vpn`):**
  - Take a baseline peer throughput measurement: pick a well-seeded torrent (e.g. Interstellar 4K from TD or a large Linux ISO from a public tracker). Start streaming; sample `GET /api/torrent/status/<hash>` every 10s for 2 minutes. Record min/max/median downloadSpeed.
  - `curl -s http://localhost:3000/api/system/vpn-health | jq .` — confirm `mode: "vpn"`, reachable, not leaking (baseline).
- [ ] **Copy new/updated artefacts to the box:**
  ```
  # From the repo checkout on the box:
  sudo cp scripts/td-fetcher.js scripts/ns-fetcher.js /opt/castcrate/scripts/
  sudo chmod 755 /opt/castcrate/scripts/td-fetcher.js /opt/castcrate/scripts/ns-fetcher.js
  sudo cp scripts/netns-up.sh scripts/run-server.sh /opt/castcrate/scripts/
  sudo chmod 755 /opt/castcrate/scripts/netns-up.sh /opt/castcrate/scripts/run-server.sh
  sudo cp deploy/systemd/castcrate-netns.service /etc/systemd/system/
  sudo systemctl daemon-reload
  # Rebuild the server so the config.ts + torrentday.ts + vpn-health.ts changes ship:
  cd /home/castcrate/castcrate && pnpm --filter @castcrate/server build
  ```
- [ ] **Switch to v2 mode:**
  - Edit `/home/castcrate/castcrate/apps/server/.env` → change `VPN_MODE=vpn` to `VPN_MODE=torrentday-only`.
  - `sudo systemctl restart castcrate-netns.service castcrate.service`.
  - Wait 5s.
- [ ] **Verify placement:**
  - `ss -tlnp | grep :3000` — node process should be OUTSIDE the ns (a `readlink /proc/<pid>/ns/net` on it should return the host's netns inode, not the `castcrate-ns` one).
  - `ip netns exec castcrate-ns ip link` — should list `lo` + `wg-castcrate` ONLY. No `veth-cc-ns`.
  - `iptables -t nat -L PREROUTING -n` — no `10.200.200.2:3000` DNAT rule.
  - `iptables -L FORWARD -n | head` — no `10.200.200.0/30 ACCEPT` rules.
  - `curl -s http://<box>:3000/api/ping` from LAN → 200 (Fastify on host, no DNAT needed).
- [ ] **Verify tunnel is up:**
  - `curl -s http://<box>:3000/api/system/vpn-health | jq .` → `{ mode: "torrentday-only", publicIp: <VPN IP>, country: "<XX>", reachable: true, leaking: false, wgPeer: "<endpoint>", lastCheckedAt: <ms> }`.
  - `sudo ip netns exec castcrate-ns /usr/bin/node /opt/castcrate/scripts/ns-fetcher.js https://1.1.1.1/cdn-cgi/trace` → returns Cloudflare trace with the VPN exit IP.
- [ ] **Verify TorrentDay works:**
  - From the LAN UI: search "Interstellar" (or another known-TD title). Confirm non-empty results from source `"torrentday"`.
  - Click a result → confirms the `.torrent` blob fetch works (which uses the same subprocess pattern).
  - `journalctl -u castcrate --since "5 min ago" | grep torrentday` — should show `torrentday: subprocess fetch → ns` lines (no cookies).
- [ ] **Verify other sources still work:**
  - Search a title likely to hit YTS or Knaben. Confirm results come from those sources.
  - Confirm those requests exit via clearnet: `sudo tcpdump -n -i <lan_if> host yts.mx or host knaben.eu -c 5` should show packets (they're going out the host's default route).
- [ ] **Verify Chromecast still works:**
  - `curl -s http://<box>:3000/api/cast/devices` — Chromecast discovered.
  - Trigger a full cast (Interstellar → Master Llama, same regression as v1).
  - Confirm playback on TV.
- [ ] **Measure v2 throughput:**
  - Start the same well-seeded torrent used in the baseline. Sample downloadSpeed every 10s for 2 minutes. Record min/max/median.
  - **Expected outcome:** median ≥ 5 MB/s (target from requirements), and materially higher than the v1 baseline (typical improvement should be 2-10x depending on peer geography).
  - Document the numbers in `context.md`.
- [ ] **Kill-switch verification (v2-specific):**
  - `sudo ip netns exec castcrate-ns wg-quick down wg-castcrate` (or `ip -n castcrate-ns link set wg-castcrate down`).
  - Trigger a TD search from the UI. Confirm it fails cleanly (empty result with `code: "fetch"` in the errors).
  - Trigger a YTS search. Confirm it STILL WORKS (v2 kill-switch is TD-only; other sources on clearnet are unaffected).
  - `curl -s http://<box>:3000/api/system/vpn-health | jq .` → `{ reachable: false }`.
  - Nav pill flips to `?` (amber unreachable) within 60s.
  - Bring WG back up; confirm TD search recovers on the next attempt.
- [ ] **Regression: swap back to `VPN_MODE=vpn`, verify v1 still works byte-identically:**
  - Edit `.env` → `VPN_MODE=vpn`. `sudo systemctl restart castcrate-netns castcrate`.
  - `curl -s http://<box>:3000/api/system/vpn-health` → `{ mode: "vpn", ... }` with VPN IP.
  - Trigger a search → still works.
  - Cast → still works.
  - Swap back to `torrentday-only` for the ongoing deploy.
- [ ] **Regression: swap to `VPN_MODE=off`, verify no-op path:**
  - Edit `.env` → `VPN_MODE=off`. `sudo systemctl restart castcrate castcrate-netns`.
  - `systemctl is-active castcrate-netns` → `inactive`.
  - Fastify on host, TD search returns empty (regression baseline — TD blocked without VPN).
  - Swap back to `torrentday-only`.
- [ ] **Update context.md:**
  - Record baseline vs v2 throughput numbers.
  - Note any deviations from the plan surfaced by the real box (there will be some; document them alongside the amendments).

**Files touched (on the box, outside the repo):**
- `/etc/systemd/system/castcrate-netns.service`
- `/opt/castcrate/scripts/{netns-up.sh,run-server.sh,td-fetcher.js,ns-fetcher.js}`
- `/home/castcrate/castcrate/apps/server/.env`
- Rebuilt `/home/castcrate/castcrate/apps/server/dist/*`

**Files touched (repo, deferred amendments):**
- `docs/features/castcrate/vpn-torrentday-only/context.md` (new — created during work; captures real-box findings, throughput numbers, any deviations).

**Acceptance criteria (executed on the deployed box)**
- Placement: node process on host; ns contains only `lo` + `wg-castcrate`; no DNAT / FORWARD rules.
- Tunnel: `vpn-health` reports `torrentday-only` mode + VPN exit IP + reachable.
- TD works: search returns non-empty; `.torrent` blob fetch succeeds; adapter logs show subprocess pattern.
- Other sources work: YTS / Knaben searches return; tcpdump shows their traffic goes clearnet.
- Chromecast works: full E2E cast succeeds (Interstellar → Master Llama).
- Throughput: median ≥ 5 MB/s on a well-seeded title; materially higher than v1 baseline.
- Kill-switch (v2 semantics): TD fails on WG down; other sources still work; pill flips amber; recovery on WG up.
- Regressions: swapping to `VPN_MODE=vpn` restores v1 byte-identical; swapping to `VPN_MODE=off` restores no-op byte-identical.
- No SSH lockout, no unexpected iptables residue after each mode swap.

---

## Key Technical Decisions

### 1. Subprocess-in-ns vs SOCKS proxy vs cgroups per-app routing

**Decision:** Spawn a short-lived `ip netns exec castcrate-ns node scripts/td-fetcher.js <url>` per TD fetch. Body flows through stdout back to the parent.

**Alternatives considered:**
- **Long-running SOCKS5 proxy inside the ns.** Rejected. Would require: (a) another systemd unit for the proxy daemon, (b) an internal port to protect from other-user access on the host (which currently has no other users but the surface exists), (c) an in-process undici `Agent` swap in `torrentday.ts` to route through the proxy address, (d) a way for the proxy to be reachable from the host without opening it externally. All doable but strictly more moving parts than a per-fetch subprocess. SOCKS5 gains: connection pooling (marginal — TD fetches are user-initiated, seconds-scale, not high-throughput).
- **cgroups + iptables `-m owner` per-process routing** (netfilter marks packets from a specific PID/cgroup, policy routing sends marked packets via WG). Rejected. Node is a single OS process; there's no way to say "this fetch goes VPN, that fetch goes clearnet" at the socket-owner layer without either (a) forking a helper process per fetch (which is what we're doing, but with a nicer name), or (b) doing socket-level bind manipulation from inside libuv which we can't do without native code. Also: complexity, cgroup version quirks (v1 vs v2), interaction with systemd's own cgroup usage.
- **nftables `-t mangle` marking based on destination host or socket UID.** Rejected. Same "Node is one process" limitation as cgroups; destination-based marking would need us to hardcode TD's IP ranges (fragile: `torrentday.com` DNS may return CDN-fronted IPs).
- **Undici `Agent` with a custom `connect`.** Considered. We'd write a `Dispatcher` that opens sockets inside the ns via some kernel API. Rejected: no supported way to do `setns()` per socket from userspace Node without native bindings. The `ip netns exec` command shells the kernel API into a subprocess entry point; we're using the tool that already exists.

**Rationale:** Per-fetch subprocess is the proven-simple approach. Podman (containers), various self-hosted setups (piraprxy, torrentcontroller), and dozens of `ip netns` tutorials use exactly this pattern. Overhead is a `fork+exec` per fetch (~5ms on modern hardware) + a Node cold-start (~30-50ms) — for TD which does a few searches per user session and a `.torrent` download per pick, this is imperceptible. If we ever need to hit TD at a rate where subprocess spawn cost matters, we can add pooling later; YAGNI now.

### 2. `td-fetcher.js` is stdlib-only (no npm imports)

**Decision:** `td-fetcher.js` imports only `node:https`, `node:http`, `node:process`, `node:url`. Not `undici` (even though it's already installed), not `node-fetch`, not `got`, not `cheerio`. Same for `ns-fetcher.js`.

**Alternatives considered:**
- **Import `undici` from the app's `node_modules`.** Consistent with the rest of the codebase; `fetch()` shape is more ergonomic. Rejected: adds dependency-resolution surface (the subprocess needs `require.resolve('undici')` to work, which means it needs to be spawned with a `cwd` inside the workspace where the `pnpm` symlink graph resolves). Also: pins the subprocess to the exact `undici` version the app was built with; a `pnpm update` could introduce a subtle change in redirect handling that only manifests inside the subprocess.
- **Rely on `globalThis.fetch` (Node 22+ built-in).** Also stdlib in the sense of "no npm import". Considered. Rejected only because `https.get()` gives explicit control over `Location` header handling and cookie sending in one place; `fetch()` in Node's built-in ends up requiring more careful `redirect: "manual"` semantics that already tripped us up once in the main app.

**Rationale:** Subprocess isolation is the security property we want. The fetcher runs with the TD cookies in its env. Any npm dependency it imports is a potential supply-chain surface for a "malicious postinstall reads TD_UID/TD_PASS from env and posts them to an attacker" attack. Stdlib-only eliminates the surface entirely. Also: script fits in ~100 lines, no ergonomic loss.

### 3. Three-mode `VPN_MODE` (not two-mode with a sub-flag)

**Decision:** `VPN_MODE` takes one of three values: `vpn`, `torrentday-only`, `off`. Not `VPN_MODE=vpn` + `VPN_SPLIT=true` or similar.

**Alternatives considered:**
- **Two-mode + boolean sub-flag** (`VPN_MODE=vpn` + `VPN_SELECTIVE=torrentday`). Rejected. Two-dimensional config invites illegal combos (`VPN_MODE=off VPN_SELECTIVE=torrentday` — meaningless), which the code has to reject or silently coerce. The whole point of the config is to answer "what's the runtime routing model?" with one atomic choice.
- **Named modes with more granularity** (`vpn-full`, `vpn-tdonly`, `vpn-tdonly-plus-knaben`, …). Rejected. YAGNI — there's exactly one selective source today (TorrentDay). If a second private tracker lands, we widen the mode-name meaningfully then, or extract to a list-typed `VPN_ROUTE_SOURCES=torrentday,redacted` — but not now.

**Rationale:** One env var, one answer. Users understand a three-way switch. Grep-friendly (`grep -r 'torrentday-only'` finds every branch point). Additive to the v1 mode.

### 4. Reusing netns infra, not rebuilding a separate one

**Decision:** Same `castcrate-ns` namespace, same `castcrate-netns.service` unit, same `wg0.conf` path. `netns-up.sh` branches on `VPN_MODE` to skip the veth/DNAT/FORWARD steps under `torrentday-only`.

**Alternatives considered:**
- **Two separate ns units** (`castcrate-ns-full`, `castcrate-ns-selective`), user picks which one to enable. Rejected — duplicates infrastructure, forces two nearly-identical scripts, creates a "what happens if both are enabled" surface.
- **Fresh script `netns-up-selective.sh`** alongside `netns-up.sh`. Rejected — script duplication is worse than a mode branch; the shared setup (namespace, WG, resolv.conf) is >50% of the code.

**Rationale:** Mode-branching in a single script keeps the two configurations honestly close to each other — a diff-review shows exactly what's different. If we ever split the ns for other reasons (multi-tenancy, unlikely), we can extract then.

### 5. Kill-switch semantics per mode

**Decision:**
- `off`: no kill-switch (no VPN to fail).
- `vpn`: fail-closed for all outbound (v1 semantics, unchanged).
- `torrentday-only`: fail-closed for TD only. Other sources continue to work on clearnet.

**Alternatives considered:**
- **Fail-closed for everything in v2 mode too** (if WG is down, refuse all searches). Rejected — inconsistent with the mode's whole purpose. A v2 user has already opted to trade full-tunnel privacy for throughput; blocking non-TD sources when WG is down doesn't restore privacy, it just breaks the app.

**Rationale:** Documented explicitly in `requirements.md`'s Out of Scope. The semantics match user expectation ("only TD needs the VPN, so only TD is affected by VPN outages"). Fail-closed for TD is natural — the subprocess errors on WG down (WG is the ns's default route, so `td-fetcher.js` will get `ECONNREFUSED` or timeout).

### 6. Coexistence with v1 mode and `proxy-routing`

**Decision:**
- v1 (`vpn`) and v2 (`torrentday-only`) coexist as first-class modes. No code from v1 is removed. Users can switch by changing `VPN_MODE=` and restarting units.
- `proxy-routing`'s `getDispatcher("torrentday")` is honoured for the direct-fetch codepath (i.e. under `vpn` and `off` modes). Under `torrentday-only` the dispatcher is ignored (subprocess uses stdlib `https`); we emit a one-time warn log to make this visible.

**Alternatives considered:**
- **Have the subprocess also honour the proxy setting** — pass `PROXY_URL` via env and construct an `https.Agent` with proxy support. Rejected — would either require adding a proxy-agent npm package (violates stdlib-only, see Decision 2) or hand-rolling CONNECT tunneling in the subprocess. Not worth it: users in v2 mode who also configure a source-specific proxy for TD are stacking two overlapping mechanisms; the VPN tunnel already achieves what the proxy would.
- **Remove `proxy-routing`'s TD support entirely under v2 mode.** Rejected — silently dropping a configured setting is worse than logging that we're ignoring it. The one-time warn tells the user "you have both a proxy and v2 mode configured; only the VPN is being used".

**Rationale:** Additive coexistence. Users on v1 keep working. Users on v2 who also had a TD proxy configured will see one warn line at boot; they can remove the proxy setting if they no longer need it.

### 7. Two-script split: `td-fetcher.js` (auth-required) + `ns-fetcher.js` (auth-optional)

**Decision:** `td-fetcher.js` requires `TD_UID`/`TD_PASS` and errors out if either is missing. A separate `ns-fetcher.js` (used only by vpn-health probes to `1.1.1.1/cdn-cgi/trace`) is authless.

**Alternatives considered:**
- **Single script with a `TD_ALLOW_NO_AUTH=1` env flag** that bypasses the cred check. Rejected — introduces a security-sensitive branch in the same script that handles TD auth cookies. A misconfigured caller could pass the flag and bypass what should be a mandatory check.
- **Auth-optional in a single script** (send cookies only if both are present). Rejected — the fetcher currently used only for TD, and TD without cookies is meaningless (returns the login page). Making cookies optional weakens the invariant.

**Rationale:** Purpose-locked scripts are easier to audit. `td-fetcher.js` header comment says "only for TorrentDay fetches; requires cookies". `ns-fetcher.js` header says "only for public unauthenticated URLs via the ns; no cookies". A future engineer reading either file knows exactly what it does.

### 8. Server on host under v2, `CASTCRATE_LAN_IP` env kept honoured

**Decision:** Fastify runs on the host in v2 mode. `os.networkInterfaces()` sees real interfaces again, so `getLanIp()` auto-detects correctly. `CASTCRATE_LAN_IP` env is still respected (v1 semantic) — under v2 it's a no-op if unset (auto-detect works), but honouring the env means a user swapping between modes doesn't have to also toggle this.

**Rationale:** No new footgun. `CASTCRATE_LAN_IP` was a v1 workaround; in v2 it's inert. Removing it would break users who switch back to v1. Keeping it honoured is one line of code (already present).

### 9. Subprocess timeout matches HTTP timeout with parent-side guard

**Decision:** `td-fetcher.js` uses `TD_TIMEOUT_MS=15000` (matches `torrentday.ts`'s existing `AbortSignal.timeout(15_000)`). The parent adds a 20s outer guard that `SIGKILL`s the child if it hangs past the inner timeout.

**Rationale:** Belt-and-braces. The inner timeout handles network stalls; the outer guard handles the pathological case where the subprocess itself hangs (e.g. Node's event loop stuck, `SIGSEGV` in a native module — though we have no native modules in the fetcher). Without the outer guard a hung subprocess could leak file descriptors on the parent Fastify indefinitely.

### 10. Binary safety on stdout — pipe raw bytes, no `.toString()`

**Decision:** `td-fetcher.js` uses `res.pipe(process.stdout)`; parent reads stdout as `Buffer[]` and concatenates. No `.toString('utf8')` anywhere in the pipeline until the parent decides whether it's HTML (utf8 decode) or a `.torrent` blob (keep as Buffer).

**Rationale:** `.torrent` files are binary bencode. A single `.toString('utf8')` anywhere would corrupt the payload. Node stream pipes preserve bytes exactly. Parent-side `Buffer.concat(chunks)` gives us the raw payload; the caller (`fetchTdBytes` or `fetchTdHtml`) then either returns the Buffer as-is or decodes to string.

---

## Definition of Done

### Functional (v2 mode on the deployed box)

- [ ] `curl -s http://<box>:3000/api/system/vpn-health | jq .` returns `{ mode: "torrentday-only", publicIp: <VPN IP>, country: "<XX>", reachable: true, leaking: false, wgPeer: "<endpoint>", lastCheckedAt: <recent ms> }`.
- [ ] `ss -tlnp | grep :3000` on the box shows the node process bound directly to the host (not inside the ns). `readlink /proc/<node_pid>/ns/net` returns the host netns inode, not `castcrate-ns`.
- [ ] `ip netns exec castcrate-ns ip link show` returns only `lo` and `wg-castcrate` (no `veth-cc-ns`).
- [ ] `iptables -t nat -L PREROUTING -n` shows no DNAT to `10.200.200.2:3000`.
- [ ] `iptables -L FORWARD -n` shows no `10.200.200.0/30 ACCEPT` rules.
- [ ] TorrentDay search from the LAN UI returns non-empty results with the box's system-level VPN OFF.
- [ ] `journalctl -u castcrate --since "5 min ago"` shows `torrentday: subprocess fetch → ns` log lines; contains no cookie material (grep `-E "uid=|pass="` returns nothing).
- [ ] All other sources (YTS, Knaben, Stremio, OMDb) still return results; `tcpdump -n -i <lan_if> host yts.mx` shows their traffic exits clearnet.

### Throughput

- [ ] Baseline measurement recorded under `VPN_MODE=vpn` (v1 mode) for a well-seeded reference torrent: {min, median, max} MB/s over a 2-minute window.
- [ ] v2 measurement recorded under `VPN_MODE=torrentday-only` for the same torrent: median ≥ 5 MB/s AND materially higher than v1 baseline (target: ≥2x improvement; realistic depending on peer geography).
- [ ] Numbers documented in `context.md` with the torrent used, tracker, seed count at measurement time.

### Regression (v1 + off modes)

- [ ] `VPN_MODE=vpn`: `curl /api/system/vpn-health` returns `mode: "vpn"` + VPN IP; TD search works; cast (Interstellar → Master Llama) works.
- [ ] `VPN_MODE=off`: `castcrate-netns.service` is `inactive`; Fastify on host; `vpn-health` returns `mode: "off"`; behaviour byte-identical to pre-feature baseline.

### Kill-switch (v2-specific)

- [ ] `sudo ip -n castcrate-ns link set wg-castcrate down`. Trigger a TD search from the UI:
  - Search fails cleanly (empty results, `errors[]` contains `{ source: "torrentday", code: "fetch" }`).
  - `curl /api/system/vpn-health` → `{ reachable: false }`.
  - Nav pill flips to amber `?` within 60s.
  - `tcpdump -n -i <lan_if> host torrentday.com` shows zero packets during the failed-search window (proves TD stayed inside the tunnel — no leak).
- [ ] YTS/Knaben searches STILL WORK during this window (v2 kill-switch is TD-only).
- [ ] Bring `wg-castcrate` back up; next TD search succeeds within one retry cycle.

### Security / hygiene

- [ ] `grep -rE "TD_UID|TD_PASS|uid=|pass=" /var/log/journal/*` after a TD search returns nothing (no cookie material in logs).
- [ ] `grep -rE "TD_UID|TD_PASS|PrivateKey" apps/ packages/ scripts/` returns nothing (no credentials in repo).
- [ ] `ps -ef | grep td-fetcher` during a search shows the subprocess argv contains ONLY the URL, not the cookies (env-only cookie passing verified).
- [ ] `strings /proc/<subprocess_pid>/environ` during a search shows `TD_UID=` and `TD_PASS=`; after the subprocess exits, `strings /proc/<parent_pid>/environ` does NOT show them (parent Fastify never sets them in its own env).
- [ ] IPv6 sanity: `ip netns exec castcrate-ns ip -6 addr` shows nothing; v6 fetches from inside the ns fail cleanly (regression check from v1).

### Verification method (an evaluator runs these on the deployed box)

1. `ssh castcrate@<box>`.
2. Verify placement + rule absence per the "Functional" checklist above.
3. `curl -s http://localhost:3000/api/system/vpn-health | jq .` → verify shape and `mode: "torrentday-only"`.
4. From a LAN laptop: open `http://<box>:3000`. Confirm nav pill shows green `TD-only · <country>`.
5. From LAN laptop UI: search "Interstellar". Confirm non-empty TD results.
6. Cast to Master Llama. Confirm playback.
7. Start streaming a well-seeded reference torrent. Sample `/api/torrent/status/<hash>` for 2 min. Confirm median ≥ 5 MB/s.
8. On the box: `sudo tcpdump -n -i <lan_if> host torrentday.com &`; note the PID.
9. On the box: `sudo ip -n castcrate-ns link set wg-castcrate down`.
10. In the UI: trigger a TD search. Confirm error state. `sudo kill <tcpdump_pid>` and inspect — expect zero TD traffic (stayed in the tunnel).
11. In the UI: trigger a YTS search. Confirm it succeeds (clearnet).
12. On the box: `sudo ip -n castcrate-ns link set wg-castcrate up`. Retry TD → succeeds.
13. Regression: edit `.env` → `VPN_MODE=vpn`; `sudo systemctl restart castcrate-netns castcrate`. Verify v1 mode works; then swap back.
14. Regression: edit `.env` → `VPN_MODE=off`; verify no-op; then swap back.

All steps observable — no "check the logs manually".

### Non-goals for DoD (out of scope, documented)

- Multi-source selective VPN (e.g., route TD + Redacted via VPN, everything else clearnet).
- SOCKS proxy alternative implementation.
- v1 removal (`VPN_MODE=vpn` stays).
- UI-driven mode switching (SSH + env edit + restart is the change path).
- Auto-migration of existing v1 users to v2.

---

## Testing Strategy

### Unit tests (Vitest)

- **`config.ts` env parsing** (Phase 1): 4 cases (`vpn` / `torrentday-only` / `off` / unset+garbage).
- **`td-fetcher.js` behaviour** (Phase 2): 7 cases via spawn against a local http server (200 HTML, 200 binary, 302 redirect, 401, socket close, missing creds env, missing argv) + explicit redaction test.
- **`ns-fetcher.js` behaviour** (Phase 5): 6 mirror cases (no auth gating).
- **`torrentday-fetch.ts` subprocess wiring** (Phase 3): 5 cases via `vi.mock('node:child_process')` — `off` uses `fetch()`, `torrentday-only` uses `spawn`, error mappings for exit codes 20/22, binary-safety of stdout Buffer.
- **`vpn-health.ts` mode expansion** (Phase 5): +3 cases for `torrentday-only` (probe success, probe failure, leak detection); split existing "off short-circuit" test.

Total new Vitest cases: ~25. Existing 248-test suite must continue passing (no regressions).

### Static + lint

- `pnpm typecheck` clean across all workspaces.
- `pnpm lint` — no new errors introduced.
- `bash -n scripts/*.sh` on all shell scripts.
- `node --check scripts/*.js` on new JS scripts.
- `shellcheck` on all shell scripts (rerun in Phase 8 on Ubuntu).

### Integration / E2E (manual, real box)

- Phase 8 runbook — full three-mode swap test, throughput measurement, kill-switch, regressions.
- No automated integration tests — CI cannot allocate a Linux netns.

### Fail-closed test (explicit)

Documented in Phase 8 and DoD "Kill-switch" section. Requires `tcpdump` — executed on the box.

---

## Dependencies

### Repo — v1 infrastructure

- `vpn-split-tunnel` v1 must be deployed and working (this is documented as a hard prereq in `requirements.md`). Specifically:
  - `castcrate-netns.service` unit installed at `/etc/systemd/system/`.
  - `/etc/castcrate/wg0.conf` present, mode 600.
  - `/opt/castcrate/scripts/{netns-up.sh, netns-down.sh, run-server.sh}` present.
  - `HOST_CLEARNET_IP` set in `.env`.

### Repo — sibling features

- `torrentday-indexer` — primary consumer of the subprocess pattern. No API-level change to the adapter; only the HTTP client swaps under one mode.
- `vpn-split-tunnel` v1 — coexists; no code removal.
- `proxy-routing` — coexists with a one-time warn under v2 (see Decision 6).
- All other sources (`yts-streaming`, `knaben-fallback`, `stremio-addon-source`, `omdb-search`, subtitles) — unaffected; they use host clearnet in v2 mode.

### External / research

- None. Subprocess-in-ns pattern is well-established (podman, tutorials). No external facts drive the design.

### Host packages

- Same as v1: `wireguard-tools`, `iproute2`, `iptables-nft`. Already installed if v1 is deployed.
- Node 22+ (already installed for Fastify).

---

## Risks & Mitigation

### R1. Subprocess overhead per fetch

**Risk:** `spawn()` + Node cold-start is ~30-80ms overhead per TD fetch. TD makes a few fetches per user session (search + `.torrent` blob). Cumulative overhead is imperceptible for user-initiated actions but could stack if TD is called in a tight loop.

**Mitigation:** TD is called at most a few times per session (search, then one `.torrent` per selected result). No tight loops. If a future feature ever calls TD at a high rate, we add subprocess pooling (or move to a SOCKS proxy) then. YAGNI now.

**Detection:** Log line at each subprocess spawn (`torrentday: subprocess fetch → ns`); if the frequency ever exceeds a few per second, that's a signal to revisit.

### R2. Env-var cookie leak to child processes

**Risk:** `TD_UID` and `TD_PASS` are passed to the subprocess via env. If the subprocess spawns any further child (e.g. `node`'s startup does anything unusual), the grandchild would inherit the env.

**Mitigation:**
- `td-fetcher.js` is minimal and spawns nothing. Just does an HTTP request.
- Explicitly pass a scoped env to the subprocess (`{ PATH: "/usr/bin:/usr/sbin", TD_UID, TD_PASS, TD_UA, TD_TIMEOUT_MS }` — no full parent env passthrough). This limits inherited env size and doesn't leak unrelated app env into the subprocess.
- DoD includes an explicit `strings /proc/<pid>/environ` check on parent (must NOT show `TD_UID=`) and subprocess (must show them). Verified in Phase 8.

### R3. Stdout buffering for large `.torrent` blobs

**Risk:** `.torrent` files can be ~1MB for large multi-file torrents. Node's stdout has a default write buffer; pipe backpressure between the subprocess and the parent could cause hangs.

**Mitigation:**
- `res.pipe(process.stdout)` in the subprocess handles backpressure natively (writable stream applies backpressure to readable).
- Parent uses `spawn(..., { stdio: ["ignore", "pipe", "pipe"] })` and drains stdout continuously into a `Buffer[]` array (not `Buffer.concat` in a loop — that'd be O(n²)).
- Parent-side outer timeout (20s) `SIGKILL`s the subprocess if backpressure ever causes a hang.

**Detection:** Vitest binary-safety case (Phase 2) uses a Buffer > 100KB with random bytes; parent must reassemble byte-identical.

### R4. Mode-switching leaves stale state

**Risk:** User edits `.env` from `VPN_MODE=vpn` to `VPN_MODE=torrentday-only` and restarts Fastify (`systemctl restart castcrate`) but forgets to restart the netns unit. The netns still has veth + DNAT from the previous run, but Fastify is now on the host — DNAT points at a non-existent server; TD adapter subprocess assumes the new-mode ns shape.

**Mitigation:**
- Runbook Phase 8 step: mode swap always includes `systemctl restart castcrate-netns.service castcrate.service` (both units, in that order).
- `netns-up.sh` is idempotent — restarting the netns unit under a new mode will "correctly reconfigure" (the veth/DNAT/FORWARD steps get skipped under the new mode, but the pre-existing veth/DNAT/FORWARD from the previous run are NOT auto-removed).
- **Gap:** `netns-up.sh` doesn't remove stale infra from a previous mode. If we detect `NEED_LAN_BRIDGE=0` but a `veth-cc-host` interface exists, that's a stale-state signal. **Mitigation:** add a check at the top of `netns-up.sh`: when `NEED_LAN_BRIDGE=0`, if `ip link show veth-cc-host` returns success, log a warning and refuse to proceed with a message pointing at `netns-down.sh`. This forces the user to explicitly tear down before switching modes. **Alternative:** auto-tear-down stale infra. Rejected — surprising and destructive; explicit is better.
- Document in Phase 7 runbook: mode swap procedure is `systemctl stop castcrate castcrate-netns; edit .env; systemctl start castcrate-netns castcrate`.

### R5. TD adapter races the ns being up

**Risk:** User calls the UI immediately after `systemctl restart` — Fastify starts, `torrentday.ts` is asked to search, subprocess spawns `ip netns exec castcrate-ns …` but the netns unit hasn't finished starting yet.

**Mitigation:**
- Systemd ordering: `castcrate.service` has `After=castcrate-netns.service` (v1 semantics preserved) — Fastify won't start until the netns unit's `ExecStart` (`netns-up.sh`) completes. Under v2 mode `netns-up.sh` still completes before Fastify starts, so the ns is ready when the first TD fetch happens.
- `Wants=` (not `Requires=`) on the netns unit — Fastify still starts even if the netns unit fails, but then TD fetches will error out cleanly (subprocess exits non-zero with "network" class). This is the correct behaviour: other sources still work.
- Runbook Phase 8 verification: after restart, wait for both units to be `active` before triggering a search.

### R6. `netns-up.sh` skips WG under a bad env

**Risk:** Someone sets `VPN_MODE=off` and forgets to also `systemctl disable castcrate-netns.service`. The unit's `ConditionPathExists=/etc/castcrate/wg0.conf` will still be true (config file still present), the unit runs, `netns-up.sh` hits the `die` branch under the `*` case in `VPN_MODE` gating.

**Mitigation:**
- The `die` message explicitly says "netns-up.sh should not run for VPN_MODE=$VPN_MODE" — actionable.
- systemd reports the unit as `failed`; `journalctl` shows the die message.
- Fastify unit is `Wants=` on netns, so Fastify still starts (on host, per `run-server.sh`'s `off` branch). App works; the failed netns unit is a visible red flag in `systemctl status`.

### R7. `ns-fetcher.js` reused for something it wasn't designed for

**Risk:** Future engineer sees `ns-fetcher.js` and thinks "great, a generic in-ns HTTP fetcher" and uses it for something that shouldn't take that path (e.g. fetches a user-provided URL, opening SSRF surface).

**Mitigation:**
- Script header comment explicitly limits its purpose: "only for vpn-health probes to public unauthenticated URLs".
- Only one call site in the codebase (`vpn-health.ts`). Any new call site should trigger a code-review question.
- If a real second use case arises, extract to a shared helper with a documented interface then.

### R8. IPv6 (leaks or lack thereof)

**Risk:** v1 explicitly disabled IPv6 inside the ns. In v2 mode the ns has no processes listening; nothing in-ns needs v6. But the subprocess we spawn per-fetch inherits the ns's disabled-v6 state, so it can only do v4 — meaning TD fetches will fail if TD ever moves to v6-only endpoints (unlikely for a private tracker in 2026 but noted).

**Mitigation:**
- Same v1 v6-disabled behaviour retained. No new v6 leak surface.
- If TD ever needs v6, add a follow-up feature to enable v6 in the ns; not needed today.

### R9. Coexistence surprise between `proxy-routing` and v2 mode

**Risk:** User has `proxyEnabled.torrentday = true` in settings AND `VPN_MODE=torrentday-only`. The direct-fetch codepath would honour the proxy; the subprocess codepath ignores it. This means `vpn-health` (via subprocess) would report tunnel state, but a TD fetch (subprocess) would ALSO ignore the proxy — different behaviour vs `vpn` mode where the dispatcher is honoured (proxy is applied to fetches that then exit via the tunnel).

**Mitigation:**
- Documented in Decision 6.
- One-time warn log at first TD fetch under v2: `torrentday: proxy dispatcher configured but ignored under VPN_MODE=torrentday-only (subprocess uses stdlib HTTPS)`. User can then decide to remove the proxy setting or accept it as a no-op.
- Do not error; the behaviour is well-defined (proxy is ignored), just surprising. Warn once.

---

## Quality Bar

- **Zero regressions on v1 modes.** `VPN_MODE=vpn` and `VPN_MODE=off` must produce byte-identical behaviour to what v1 shipped. Verified in Phase 8 by explicit swap-and-verify steps.
- **Subprocess isolation is airtight.** No cookie/env leak to the parent, no cookie in argv (env-only), no cookie in logs, no cookie in stderr, no cookie in the parent process's own environ. Verified in DoD via `strings /proc/*/environ` checks.
- **Fast fail.** Subprocess timeout (15s) matches the direct-fetch timeout (15s); parent-side outer guard (20s) `SIGKILL`s hung subprocesses. No unbounded waits.
- **Purpose-locked scripts.** `td-fetcher.js` requires TD creds; `ns-fetcher.js` doesn't send cookies. Neither is a generic fetcher — both are one-purpose scripts with header comments spelling out their scope.
- **Stdlib-only in the subprocess.** No npm imports in `td-fetcher.js` or `ns-fetcher.js`. Eliminates supply-chain surface for the cookie-carrying process.
- **Idempotent scripts.** `netns-up.sh` mode branches are idempotent — running twice under the same mode is a no-op. `netns-down.sh` remains mode-agnostic (cleans up whatever's present).
- **Reproducible on any Ubuntu Server 26.04 host** from the runbook alone. Same as v1 quality bar.
- **Absolute paths everywhere.** Tilde-footgun class of bugs stays out; every deploy artefact uses `/usr/bin/node`, `/usr/sbin/ip`, `/opt/castcrate/scripts/…`. No `$PATH` reliance in subprocess spawns.
