# vpn-torrentday-only — Context & Decisions

**Last Updated:** 2026-08-12 17:56
**Current Phase:** Phases 1-5 + 7 code-complete (backend + docs). Phase 6 (UI) running in parallel via frontend-dev agent. Phase 8 (real-box deploy + throughput measurement) is user-driven and pending.
**Status:** In Progress

---

## Quick Status

**What's Done (this session):**
- Phase 1 — Shared type + config + `.env.example`: `VpnMode` extended to `"vpn" | "torrentday-only" | "off" | "unknown"` (additive; v1 values untouched). `config.vpnMode` parser rewritten to accept the two literal values (`vpn` / `torrentday-only`), defaulting to `off` on unset/garbage/aliases (verified: `td-only`, `VPN` uppercase both collapse). `.env.example` gained a three-column "pick this if…" block. 7 unit tests in `apps/server/src/lib/__tests__/config.test.ts` cover all four cases plus the two rejected-alias guards.
- Phase 2 — `scripts/td-fetcher.js`: stdlib-only Node subprocess (`node:https` + `node:http` + `node:process` + `node:url`; zero npm imports). Cookies via env only, never argv. Binary-safe stdout (`res.pipe(process.stdout)` — no `.toString('utf8')` in the pipeline). Exit-code contract: 0 success / 2 usage / 3 missing creds / 20 3xx redirect / 21 non-2xx / 22 timeout / 23 network. 9 subprocess tests spawn the real script against a local http server per case and assert redaction end-to-end (no cookie material in stderr or stdout).
- Phase 3 — `apps/server/src/services/torrentday-fetch.ts`: new helper module; both `fetchTdHtml` and `fetchTdBytes` branch on `config.vpnMode` at call time. Under `vpn` / `off` uses direct `fetch()` with dispatcher (byte-identical to pre-v2 codepath — 17/17 existing TorrentDay tests still pass). Under `torrentday-only` spawns `/usr/sbin/ip netns exec castcrate-ns /usr/bin/node /opt/castcrate/scripts/td-fetcher.js <url>` with cookies in env; parent-side 20s outer guard SIGKILLs the child if it hangs past the inner 15s timeout. Exit codes 20/21/22/23 map to `TorrentDayAuthError` / `TorrentDay HTTP <status>` / `timeout` / stderr class. Also emits a one-time warn when a proxy-routing dispatcher is passed under v2 (Decision 6). `TorrentDayAuthError` + `TorrentDayDisabledError` extracted to `torrentday-errors.ts` to avoid a circular import; re-exported from `torrentday.ts` for backward compat. 8 new tests in `torrentday-fetch.test.ts` cover the mode gate, argv/env split (cookies NOT in argv), exit-code mapping, binary-safety round-trip, and the one-time warn latch.
- Phase 4 — `scripts/run-server.sh` three-way `case` on `${VPN_MODE:-off}`: `vpn` execs into ns, `torrentday-only` execs node on host, `off|""` execs node on host, `*` errors out non-zero. `scripts/netns-up.sh` gained a `NEED_LAN_BRIDGE` boolean derived from `VPN_MODE`; Steps 4/5 (veth), 9-11 (ip_forward + DNAT + FORWARD) wrapped in `if [ "$NEED_LAN_BRIDGE" = 1 ]`; Step 8 splits so RFC1918/multicast exceptions are conditional but the default route via WG is unconditional. R4 stale-state guard: refuses to proceed under torrentday-only if a `veth-cc-host` from a previous vpn-mode run is still present. `scripts/netns-down.sh` header updated to note mode-agnosticism (existing guarded steps already handle both modes as no-ops when state is absent). All shell scripts `bash -n` clean; `node --check` clean on both `.js` fetchers.
- Phase 5 — `apps/server/src/services/vpn-health.ts`: `getVpnHealth`'s short-circuit condition changed from `!== "vpn"` to `=== "off" || === "unknown"`. Both `vpn` and `torrentday-only` now trigger probing. New `probePublicIpViaNs()` spawns `ip netns exec castcrate-ns node /opt/castcrate/scripts/ns-fetcher.js https://1.1.1.1/cdn-cgi/trace`; reuses `parseTraceBody()` (extracted). `readWgPeer(useNs)` now optionally wraps `wg show` with `ip netns exec castcrate-ns` because under v2 Fastify is on the host but `wg-castcrate` lives inside the ns. `mode` field returns `"torrentday-only"` verbatim; leak detection works via the subprocess-probe IP just like the direct-fetch path. `scripts/ns-fetcher.js` created — twin of `td-fetcher.js` but authless; header comment explicitly limits it to public unauthenticated URLs (per Decision 7). Vitest: +5 vpn-health cases (torrentday-only success, failure, leak-detection, wg-show wrapping, plus split-out `unknown` short-circuit); +8 ns-fetcher cases.
- Phase 7 — `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 8 rewritten. Added a "Pick your `VPN_MODE`" table (three-row cross-comparison). Step 8.3 explains which value to write. Step 8.4 copy-file step now includes `td-fetcher.js` + `ns-fetcher.js`. Step 8.8 splits verification per mode (curl vs subprocess). Step 8.13 kill-switch has mode-specific expectations (v1: all fail; v2: only TD fails, YTS/Knaben continue). Step 8.14 documents the mode-swap procedure with correct stop/start ordering.

**Test counts:**
- Baseline (start of session): **248 tests passing** across 16 test files.
- After this session: **285 tests passing** across 20 test files. Net +37 (7 config + 9 td-fetcher + 8 torrentday-fetch + 5 vpn-health new + 8 ns-fetcher). All existing 248 preserved.
- `pnpm typecheck` clean across `packages/shared`, `apps/server`, `apps/web`.

**What's Next:**
- Phase 6 (UI) — running in parallel via frontend-dev agent. Their work: `apps/web/src/components/Settings.tsx` (mode explainer subsection) + `apps/web/src/components/VpnStatusPill.tsx` (add `TD-only · XX` label). See `implementation.md` §"Phase 6 — UI: settings dropdown + nav pill label" for the full task list.
- Phase 8 (real-box execution) — user-driven. Deploy `scripts/*.js` and updated `scripts/*.sh` to `/opt/castcrate/scripts/`, add `EnvironmentFile=` to `castcrate-netns.service` if needed, edit `.env` → `VPN_MODE=torrentday-only`, `sudo systemctl restart castcrate-netns castcrate`, verify per DoD checklist. Throughput measurement (v1 baseline vs v2 median) is the definitive close-out signal.

**Blockers:**
- None for backend. Phase 6 and Phase 8 both require different actors (frontend-dev agent + user with box access) but neither depends on further backend work.

---

## Key Files

### New this session

**Server:**
- `apps/server/src/services/torrentday-fetch.ts` — mode-branching TD HTTP client. `fetchTdHtml` / `fetchTdBytes` public API.
- `apps/server/src/services/torrentday-errors.ts` — extracted `TorrentDayAuthError` + `TorrentDayDisabledError` to break the circular import between `torrentday.ts` and `torrentday-fetch.ts`. Re-exported from `torrentday.ts`.
- `apps/server/src/lib/__tests__/config.test.ts` — 7 cases exercising the three-way VPN_MODE parser.
- `apps/server/src/services/__tests__/torrentday-fetch.test.ts` — 8 cases (mode branching + exit-code mapping + argv/env split + one-time warn latch).
- `apps/server/src/scripts/__tests__/td-fetcher.test.ts` — 9 cases (spawns the real script against a local http server).
- `apps/server/src/scripts/__tests__/ns-fetcher.test.ts` — 8 cases (mirrors td-fetcher; no creds required).

**Scripts (deploy):**
- `scripts/td-fetcher.js` — stdlib-only Node subprocess; cookies via env; binary-safe stdout. Lives at `/opt/castcrate/scripts/td-fetcher.js` on the deploy box.
- `scripts/ns-fetcher.js` — authless twin for the vpn-health probe. Purpose-locked in header comment.

### Modified this session

**Shared / config:**
- `packages/shared/src/index.ts` — `VpnMode` union extended (additive) + `VpnHealth.mode` JSDoc reworded.
- `apps/server/src/lib/config.ts` — `vpnMode` parser rewritten to accept three literals; JSDoc rewritten.
- `.env.example` — `VPN_MODE` block replaced with a three-row "pick this if…" reference.

**Server:**
- `apps/server/src/services/torrentday.ts` — swapped `fetch()` call sites for `fetchTdHtml` / `fetchTdBytes`; removed now-unused `buildHeaders` + `UA` + `UndiciRequestInit` import.
- `apps/server/src/services/vpn-health.ts` — three-way mode branching in `getVpnHealth`; added `probePublicIpViaNs`; extracted `parseTraceBody`; `readWgPeer` takes `useNs` boolean and wraps with `ip netns exec castcrate-ns` when set.
- `apps/server/src/services/__tests__/torrentday.test.ts` — added mock for `../../lib/config.js` (pinned to `off` mode for byte-identical direct-fetch replay); added `arrayBuffer` alongside `text` in all mock response shapes because the helper is now Buffer-native.
- `apps/server/src/services/__tests__/vpn-health.test.ts` — mocked `node:child_process` to intercept spawn; added five new cases for `torrentday-only` (success, failure, leak, wg-show wrapping, split-out `unknown` short-circuit).

**Scripts (deploy):**
- `scripts/run-server.sh` — two-way `if/else` replaced with three-way `case`; unknown value hard-errors.
- `scripts/netns-up.sh` — added `NEED_LAN_BRIDGE` boolean derived from `VPN_MODE`; wrapped Steps 4/5/9/10/11 and LAN interface detection in `if [ "$NEED_LAN_BRIDGE" = 1 ]`; Step 8 default route unconditional; R4 stale-veth guard added under `torrentday-only`.
- `scripts/netns-down.sh` — header note about mode-agnosticism (no functional change; existing guards suffice).

**Docs:**
- `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 8 — mode-selection table added; steps 8.3/8.4/8.8/8.13/8.14 rewritten per mode; acceptance clause rewritten.
- `docs/features/castcrate/vpn-torrentday-only/implementation.md` — status header flipped to In Progress + timestamp bumped.

### Related (read-only reference)

- `docs/features/castcrate/vpn-split-tunnel/` — v1 that this feature extends. `context.md` documents the gotchas (AppArmor / ip_forward / FORWARD chain / DNS resolver / ifconfig.co blocking VPN exits / tilde-footgun) that also apply to v2.
- `docs/features/castcrate/vpn-torrentday-only/requirements.md` — the spec that drove this plan.
- `docs/features/castcrate/vpn-torrentday-only/implementation.md` — 913-line full plan (10 tech decisions, DoD, testing strategy, risks R1-R9).

---

## Important Decisions

Full explanations live in `implementation.md` §Key Technical Decisions. Summary:

- **D1: Subprocess-in-ns, not SOCKS proxy or cgroups.** Per-fetch `ip netns exec castcrate-ns node scripts/td-fetcher.js <url>`. Simplest, no long-running daemon, no proxy port, no native-code bindings. Overhead (~30-80ms per fetch) is imperceptible for TD's few-per-session pattern.
- **D2: `td-fetcher.js` is stdlib-only.** No `undici`, no npm imports. Eliminates supply-chain surface for the cookie-carrying process.
- **D3: Three-mode `VPN_MODE`, not two-mode + sub-flag.** `vpn` / `torrentday-only` / `off`. One env var, one answer. Grep-friendly.
- **D4: Reused netns infra.** Same `castcrate-ns`, same unit, same `wg0.conf` path. `netns-up.sh` branches on env.
- **D5: Kill-switch per mode.** `off`: none. `vpn`: fail-closed all. `torrentday-only`: fail-closed TD only; other sources continue on clearnet.
- **D6: `proxy-routing` dispatcher ignored under v2.** One-time warn logs the coexistence surprise. Direct-fetch codepath (v1/off) still honours the dispatcher.
- **D7: Two-script split.** `td-fetcher.js` (auth-required) + `ns-fetcher.js` (authless). Purpose-locked scripts are easier to audit than a single script with a `TD_ALLOW_NO_AUTH` flag.
- **D8: `CASTCRATE_LAN_IP` still honoured under v2.** A no-op when unset (auto-detect works on the host). Kept for mode-swap symmetry.
- **D9: Inner 15s timeout + outer 20s SIGKILL guard.** Belt-and-braces.
- **D10: Binary-safe stdout — pipe raw bytes.** No `.toString()` anywhere in the subprocess or the parent-side collection buffer.

---

## Session Notes

### 2026-08-12 — Phases 1-5 + 7 backend code + docs

**Approach:** Front-loaded Phase 1 (safe type/config change) to unblock every subsequent phase's `config.vpnMode === "torrentday-only"` branching. Phase 3's helper module `torrentday-fetch.ts` was written to be Buffer-native from the start (both HTML and `.torrent` responses flow through `fetchTdBytes`, then HTML decodes at the caller) — this simplified binary-safety by making it the same codepath for both response types.

**One deviation from the plan:** implementation.md Phase 3 spec described a `TorrentDayAuthError` re-export from `torrentday-fetch.ts` importing it back from `torrentday.ts` — that would have created a circular import. Solved by extracting the two error classes to a new `torrentday-errors.ts` module and having both `torrentday.ts` and `torrentday-fetch.ts` import from there. `torrentday.ts` re-exports the classes for backward compat with every existing consumer. No test or runtime shape change.

**Two mock-test adjustments needed after the Phase 3 refactor:**
1. Existing `torrentday.test.ts` mocks used `.text()` only, but the new helper calls `.arrayBuffer()` even for HTML (Buffer end-to-end, decode at edge). Added `arrayBuffer: async () => bodyToArrayBuffer(text)` alongside every `text: async () => ...`.
2. Added `vi.mock("../../lib/config.js", () => ({ config: { vpnMode: "off" } }))` at the top so the helper's mode-branch pins to the direct-fetch codepath. Without this the helper would try to spawn `/usr/sbin/ip` on macOS dev, which doesn't exist.

**Verification:**
- `pnpm typecheck` — clean across `packages/shared`, `apps/server`, `apps/web`.
- `pnpm --filter @castcrate/server test` — 285/285 passing (baseline 248 + 37 new). No regressions.
- `bash -n` clean on all three shell scripts. `node --check` clean on both `.js` fetchers.
- `shellcheck` not available on macOS dev — will be re-run in Phase 8 on Ubuntu.

**Handoff to frontend-dev agent:** their Phase 6 tasks live in `docs/features/castcrate/vpn-torrentday-only/implementation.md` §"Phase 6 — UI: settings dropdown + nav pill label". Two files: `apps/web/src/components/Settings.tsx` (mode explainer above the existing badge) + `apps/web/src/components/VpnStatusPill.tsx` (new `TD-only · XX` label for `mode === "torrentday-only"`). Server-side surface is ready — `GET /api/settings` already returns `vpnMode: string` and `GET /api/system/vpn-health` returns the new mode value verbatim.

**Handoff to user for Phase 8:** all deploy artefacts land as documented in `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 8 (rewritten this session). Two new files to copy to `/opt/castcrate/scripts/`: `td-fetcher.js` + `ns-fetcher.js`. Updated `scripts/netns-up.sh` + `scripts/run-server.sh` need to replace the current versions on the box. `deploy/systemd/castcrate-netns.service` needs an `EnvironmentFile=` line so the netns unit sees `VPN_MODE=` at ExecStart time — this was NOT edited this session (per session-scope: don't touch existing unit files). If the deploy shows `netns-up.sh` seeing an empty `VPN_MODE` under systemd, that's the missing piece; add the line manually or via a follow-up.
