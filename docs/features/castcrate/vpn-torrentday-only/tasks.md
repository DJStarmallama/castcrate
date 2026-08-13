# vpn-torrentday-only — Task Checklist

**Last Updated:** 2026-08-12 17:56
**Progress:** Phases 1-5 + 7 complete (backend + docs). Phase 6 (UI) delegated to parallel frontend-dev agent — in progress. Phase 8 (real-box deploy + throughput measurement) — user-driven, pending.

Effort key: **S** ≤ 2h, **M** ≤ 1 day, **L** > 1 day.
Phases marked **[max-effort]** were routed to an advanced dev agent (this session for Phase 4; Phase 8 still pending user execution).

---

## Phase 1 — Extend `VpnMode` shared type + `config.ts` + `.env.example` (S) — COMPLETE

- [x] Extend `packages/shared/src/index.ts`: add `"torrentday-only"` to `VpnMode` union; JSDoc rewritten to describe all three real modes.
- [x] Rework `VpnHealth.mode` JSDoc to note that in `torrentday-only` the probe reports the tunnel's exit IP (same as `vpn`); the field describes probe path, not server placement.
- [x] Extend `apps/server/src/lib/config.ts`: rewrote `vpnMode` initializer as an IIFE that accepts three literal values, defaults to `"off"` on unset/garbage. JSDoc rewritten.
- [x] Update `.env.example`: replaced two-value doc with a three-row "pick this if…" reference block.
- [x] Unit tests `apps/server/src/lib/__tests__/config.test.ts` — 7 cases: `vpn` → `vpn`, `torrentday-only` → `torrentday-only`, `off` → `off`, unset → `off`, garbage → `off`, `td-only` alias → `off` (rejected), `VPN` uppercase → `off` (case-sensitive).
- [x] Acceptance: `pnpm typecheck` clean; all 7 cases pass.

---

## Phase 2 — Write `scripts/td-fetcher.js` (stdlib-only Node subprocess) (S) — COMPLETE

- [x] Created `scripts/td-fetcher.js`. Stdlib-only (`node:https`, `node:http`, `node:process`, `node:url`; zero npm imports). Executable bit set.
- [x] Argv shape: single required URL; usage error → exit 2.
- [x] Env inputs: `TD_UID` + `TD_PASS` required (missing → exit 3); `TD_UA` and `TD_TIMEOUT_MS` optional with documented defaults.
- [x] Behaviour: HTTPS GET with `Cookie: uid=<UID>; pass=<PASS>` (env-only, never argv). No redirect follow (matches direct adapter's `redirect: "manual"`). 3xx → exit 20 with `redirect:<Location>` on stderr. Non-2xx / non-3xx → exit 21 with `http <status>`. Timeout → exit 22. Network error → exit 23.
- [x] Never logs secrets. Stderr contains only error class + short message. Argv URL is fine in the usage line but nothing more.
- [x] Binary-safe stdout: `res.pipe(process.stdout)` — no `.toString('utf8')` in the pipeline.
- [x] Shebang + chmod +x.
- [x] `apps/server/src/scripts/__tests__/td-fetcher.test.ts` — 9 cases (missing argv; missing creds; 200 HTML; 200 binary Buffer round-trip; 302 to /login.php; 401; socket close mid-response; connection refused; explicit end-to-end redaction check for `TD_UID` and `TD_PASS` strings in stdout+stderr).
- [x] Acceptance: `node --check` clean; all 9 tests pass; explicit redaction assertion confirms no cookie material in either stream.

---

## Phase 3 — Route TD adapter fetches through the subprocess when mode is `torrentday-only` (M) — COMPLETE

- [x] Extract `apps/server/src/services/torrentday-fetch.ts`. Public API: `fetchTdHtml(url, uid, pass, dispatcher)` + `fetchTdBytes(url, uid, pass, dispatcher)`. Reads `config.vpnMode` at call time (not module init) so tests can rebind config.
- [x] `vpn` / `off` mode → direct `fetch()` (redirect: "manual", cookie headers, dispatcher, 15s timeout). Byte-identical to pre-v2 codepath.
- [x] `torrentday-only` mode → `spawn("/usr/sbin/ip", ["netns", "exec", "castcrate-ns", "/usr/bin/node", "/opt/castcrate/scripts/td-fetcher.js", url], { env: { PATH, TD_UID, TD_PASS, TD_UA, TD_TIMEOUT_MS }, stdio })`. Cookies in env, NOT argv. Parent-side 20s outer guard SIGKILLs the child if it hangs past the inner 15s timeout.
- [x] Exit code → error mapping: 20 → `TorrentDayAuthError`; 21 → `Error("TorrentDay HTTP <status>")`; 22 → `Error("TorrentDay fetch failed: timeout")`; 23/unknown → `Error("TorrentDay fetch failed: <stderr>")`.
- [x] One-time warn log when a dispatcher is passed under v2 mode (Decision 6). Latch reset via `__resetTorrentDayFetchWarnLatchForTests`.
- [x] Extracted `TorrentDayAuthError` + `TorrentDayDisabledError` to `apps/server/src/services/torrentday-errors.ts` to break the circular import. Re-exported from `torrentday.ts` for backward compat.
- [x] Updated `apps/server/src/services/torrentday.ts`: `fetchSearchHtml` calls `fetchTdHtml`; `fetchTorrentBlob` calls `fetchTdBytes`. Removed now-unused `buildHeaders` + `UA` const + `UndiciRequestInit` import.
- [x] Extended `torrentday.test.ts`: added `vi.mock("../../lib/config.js", () => ({ config: { vpnMode: "off" } }))`; added `arrayBuffer: async () => bodyToArrayBuffer(text)` alongside every existing `text: async () => ...` mock. All 17 existing cases still pass.
- [x] New `apps/server/src/services/__tests__/torrentday-fetch.test.ts` — 8 cases: (A) off uses direct fetch, spawn NOT called; (A2) vpn uses direct fetch (byte-identical); (B) torrentday-only spawns with exact argv/env shape + cookies NOT in argv; (C) exit 20 → TorrentDayAuthError; (D) exit 22 → "timeout" error; (E) binary body round-trip; (bonus) exit 21 → HTTP <status>; (bonus) one-time warn latch prevents second dispatcher-ignored log.
- [x] Acceptance: `pnpm typecheck` clean; 17 existing + 8 new = 25 torrentday-related tests all pass.

---

## Phase 4 — `scripts/run-server.sh` + `scripts/netns-up.sh` for three-mode gating **[max-effort]** (M) — COMPLETE

- [x] `scripts/run-server.sh`: two-way `if/else` replaced with three-way `case "${VPN_MODE:-off}" in vpn|torrentday-only|off|""|*)`. Each real mode logs its branch choice to stderr with `[run-server]` prefix. Unknown value hard-errors with a helpful message. `bash -n` clean; branch selection verified against all four values (vpn, torrentday-only, off, garbage) with `NODE=/bin/echo` shim.
- [x] `scripts/netns-up.sh`: added `VPN_MODE` env read + `NEED_LAN_BRIDGE` boolean near the top (after preconditions, before Step 1). Any value other than `vpn` or `torrentday-only` triggers `die` with a message pointing at systemd's `ConditionPathExists=` guard.
- [x] Wrapped Step 4 (veth pair) + Step 5 (address assignment) in `if [ "$NEED_LAN_BRIDGE" = 1 ]`.
- [x] Wrapped Steps 9-11 (ip_forward + DNAT + FORWARD ACCEPT rules) in the same block. LAN interface detection also wrapped since it's only needed to build the DNAT rule.
- [x] Split Step 8 routing so the RFC1918/multicast exception routes are conditional on `NEED_LAN_BRIDGE=1` but the default route via `wg-castcrate` is unconditional (WG is the ns's default route in both modes).
- [x] Added R4 stale-state guard: under `torrentday-only`, if a `veth-cc-host` from a previous `vpn`-mode run still exists, refuse to proceed and print a message pointing at `netns-down.sh`.
- [x] Updated the `log` line at the end to print a mode-appropriate verification hint (`curl inside ns` for v1; `ip netns exec … node /opt/castcrate/scripts/ns-fetcher.js …` for v2).
- [x] `scripts/netns-down.sh`: header note added acknowledging mode-agnosticism. No functional change (existing guarded steps already handle both modes as no-ops).
- [x] `bash -n` clean on all three shell scripts. `shellcheck` not available on macOS dev — will be re-run in Phase 8 on Ubuntu.
- [x] `deploy/systemd/*.service` — NOT touched this session per scope constraints (v1 unit already handles the three modes via `run-server.sh`). The `castcrate-netns.service` unit will need an `EnvironmentFile=` line so `netns-up.sh` sees `VPN_MODE` under systemd — flagged in `context.md` as a Phase 8 handoff item.

---

## Phase 5 — Extend `vpn-health.ts` for `torrentday-only` mode (S–M) — COMPLETE

- [x] `apps/server/src/services/vpn-health.ts`: changed the short-circuit condition from `config.vpnMode !== "vpn"` to `config.vpnMode === "off" || config.vpnMode === "unknown"`. Both `vpn` and `torrentday-only` now trigger probing.
- [x] Added `probePublicIpViaNs()`: spawns `ip netns exec castcrate-ns /usr/bin/node /opt/castcrate/scripts/ns-fetcher.js https://1.1.1.1/cdn-cgi/trace` with `NS_TIMEOUT_MS=3000` in env; 5s outer guard SIGKILLs on hang; stdout parsed via the shared `parseTraceBody()` helper (extracted from the original direct-fetch codepath).
- [x] `readWgPeer(useNs)` now accepts a boolean and wraps the `wg` invocation with `ip netns exec castcrate-ns` when set. Preserves the ENOENT-tolerant + 1s-timeout behaviour.
- [x] `getVpnHealth` now uses `probePublicIpViaNs()` under `torrentday-only` and `probePublicIp()` (direct fetch) under `vpn`. Returns `mode: "torrentday-only"` verbatim; leak detection works via the subprocess-probe IP just like the direct-fetch path.
- [x] Created `scripts/ns-fetcher.js`: purpose-locked twin of `td-fetcher.js` (stdlib-only, same exit-code contract, binary-safe). Sends NO Cookie header; does NOT read `TD_UID` / `TD_PASS`. Header comment explicitly warns against reuse for authenticated endpoints or user-controlled URLs (SSRF surface).
- [x] Extended `apps/server/src/services/__tests__/vpn-health.test.ts`: mocked `node:child_process` to intercept spawn (default: delegate to real spawn for backward-compat with macOS `wg` ENOENT). Split the existing "off short-circuit" into two cases (off + unknown, both short-circuit + no spawn). Added 4 new cases for `torrentday-only`: ns-fetcher returns trace body → correct shape; ns-fetcher exits non-zero → `reachable:false`; publicIp === HOST_CLEARNET_IP → `leaking:true`; wg show is wrapped with `ip netns exec castcrate-ns`.
- [x] Created `apps/server/src/scripts/__tests__/ns-fetcher.test.ts` — 8 cases mirroring td-fetcher (minus creds-gating): missing argv; 200 trace body; 200 binary body round-trip; 302; 500; socket close mid-response; connection refused; explicit "no auth required" check.

---

## Phase 6 — UI: settings dropdown + nav pill label (S) — DELEGATED (in progress via parallel frontend-dev agent)

- [ ] `apps/web/src/components/Settings.tsx` — mode explainer subsection above the existing badge (three-line body sourced from the `vpnMode` field on `GET /api/settings`, mode-appropriate one-line "this means…").
- [ ] `apps/web/src/components/VpnStatusPill.tsx` — add `TD-only · <XX>` label mapping for `mode === "torrentday-only" && !leaking && reachable`. Bump the pill's `max-w-` if needed; update aria-label.
- [ ] `.env.example` `VPN_MODE` docs — already covered in Phase 1 this session; frontend-dev to verify the "pick this if…" wording matches the UI copy.
- [ ] Manual browser verification (Phase 8 acceptance path): with `vpnHealth` mocked to `mode: "torrentday-only"`, pill shows `TD-only · <XX>` in green; Settings section shows the v2 explainer.

**Backend surface for the UI:** `GET /api/settings` already returns `vpnMode: string` (surfaced in v1 via `apps/server/src/routes/health.ts`). `GET /api/system/vpn-health` now returns `mode: "torrentday-only"` verbatim. Both are ready to consume.

---

## Phase 7 — Runbook update in `media-mac-deploy` Phase 8 (S) — COMPLETE

- [x] Rewrote `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 8 intro. Added a "Pick your `VPN_MODE`" table (three-row cross-comparison of placement, use-case, trade-offs).
- [x] Step 8.3 explains which value to write in `.env` (default recommendation: `torrentday-only`).
- [x] Step 8.4 copy-file step includes both new JS scripts (`td-fetcher.js` + `ns-fetcher.js`); `chmod 755` applied to both `.sh` and `.js`.
- [x] Step 8.8 verify-egress-split split per mode: v1 uses `curl` inside ns; v2 uses `ip netns exec … ns-fetcher.js …` + `ss -tlnp | grep :3000` + `readlink /proc/<pid>/ns/net` to prove Fastify is on host.
- [x] Step 8.13 kill-switch has mode-specific expectations: v1 all sources fail; v2 only TD fails, YTS/Knaben continue (via subprocess kill-switch — WG down in ns means TD's `td-fetcher.js` gets ECONNREFUSED, but everything on host clearnet is unaffected).
- [x] Step 8.14 documents the mode-swap procedure with correct stop/start ordering (`stop castcrate castcrate-netns; edit .env; start castcrate-netns castcrate`).
- [x] Acceptance clause rewritten to cover all three modes.

---

## Phase 8 — Real-box execution + throughput measurement **[max-effort]** (M) — PENDING (user-driven)

Not executed this session. Owner: user (needs SSH + physical access to the 2011 MBP box).

Full task list per `implementation.md` §Phase 8:
- [ ] Baseline throughput measurement under current `VPN_MODE=vpn`.
- [ ] Copy new artefacts to `/opt/castcrate/scripts/`: `td-fetcher.js`, `ns-fetcher.js`, updated `netns-up.sh`, updated `run-server.sh`.
- [ ] Add `EnvironmentFile=/home/castcrate/castcrate/apps/server/.env` to `castcrate-netns.service` if not already present (flagged in context.md — not modified this session per scope).
- [ ] Rebuild server: `pnpm --filter @castcrate/server build`.
- [ ] Edit `/home/castcrate/castcrate/apps/server/.env` → `VPN_MODE=torrentday-only`.
- [ ] `sudo systemctl restart castcrate-netns.service castcrate.service`.
- [ ] Verify placement (node on host, no veth, no DNAT, no FORWARD rules).
- [ ] Verify tunnel is up via `/api/system/vpn-health` + `ns-fetcher.js` invocation.
- [ ] Verify TorrentDay works (search + `.torrent` blob fetch).
- [ ] Verify other sources still work (YTS/Knaben return; tcpdump proves clearnet path).
- [ ] Verify Chromecast still works (Interstellar → Master Llama regression).
- [ ] Measure v2 throughput; document numbers in `context.md`.
- [ ] Kill-switch verification (v2-specific): WG down in ns → TD fails, YTS still works; pill flips amber; recovery on WG up.
- [ ] Regression: swap to `VPN_MODE=vpn`, verify v1 byte-identical; swap back.
- [ ] Regression: swap to `VPN_MODE=off`, verify no-op; swap back.
- [ ] Update `context.md` with real-box findings + throughput numbers.
