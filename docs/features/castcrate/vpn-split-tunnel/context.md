# vpn-split-tunnel — Context & Decisions

**Last Updated:** 2026-08-12 09:12
**Current Phase:** Phase 5 code-complete (tasks 5.1–5.5) — user browser verification pending as task 5.6. Phase 7 (real 2011 MBP box) is the next work block; Phase 6 kill-switch verification happens on the same real box during Phase 7.
**Status:** 🟡 In Progress

---

## Quick Status

**What's Done:**
- ✅ Requirements captured (`requirements.md`)
- ✅ Full implementation plan (7 phases, 10 tech decisions, DoD, testing, risks) — `implementation.md`
- ✅ Epic + all 19 sibling features surveyed for integration surface; findings folded into the plan
- ✅ Slotted into `epic-overview.md` (row #20, Platform (planned)) and `docs/overview.md` v1.4
- ✅ Phase 1 (write half): `scripts/netns-up.sh` + `scripts/netns-down.sh` written, idempotent, prefixed logging (tasks 1.4, 1.5). VM verification (tasks 1.1–1.3, 1.6–1.8) pending.
- ✅ Phase 2 (write half): `deploy/systemd/castcrate-netns.service`, `deploy/systemd/castcrate.service`, `scripts/run-server.sh` written per implementation.md Phase 2 constraints — absolute paths only, no tildes, `Requires=` (Phase 6 flips to `Wants=`), `StateDirectory=castcrate` in place (tasks 2.1–2.4). VM verification (tasks 2.5–2.7) pending.
- ✅ Phase 3 (write half): `CASTCRATE_LAN_IP` env override landed. `apps/server/src/lib/config.ts` reads `process.env.CASTCRATE_LAN_IP` (nullable string); `apps/server/src/lib/network.ts` (the file that owns `getLanIp()` — sole call site `apps/server/src/routes/cast.ts:120`) short-circuits on the env value before falling through to `os.networkInterfaces()`. `.env.example` (repo root) documents it. `pnpm typecheck` clean. macOS dev unchanged when env is unset (tasks 3.3, 3.4). VM tasks (3.1, 3.2, 3.5, 3.6, 3.7) pending live hardware.
- ✅ Phase 5 (code-complete, browser verify pending as 5.6): `apps/web/src/lib/api.ts` gained `vpnHealth(refresh?: boolean)` matching the existing client-function style (URL + `request<VpnHealth>`). New `apps/web/src/lib/countryFlag.ts` — 11-line helper, empty-string on bad input. `apps/web/src/components/Settings.tsx` gained a "Network / VPN" section positioned directly above the private-trackers Indexers section, with a mode badge (green VPN / red LEAKING / amber UNREACHABLE / grey OFF, `role="status"` + aria-label), exit IP + country + flag emoji, `Peer: …` muted line, relative "last checked" (inline helper — no date-fns needed), a Refresh button that calls `vpnHealth(true)`, and an `id="vpn-settings"` anchor for deep-linking. When `mode==="off"` a one-line explainer renders. Uses React Query (`["vpn-health"]` key) — matches the sibling sections' pattern; a 10s `setInterval` re-renders the relative timestamp only. New `apps/web/src/components/VpnStatusPill.tsx` — compact rounded pill sitting at the end of the `<nav>` in `App.tsx` (see below), colored dot + short label, 60s polling via React Query `refetchInterval` (no ad-hoc setInterval, `refetchOnWindowFocus:false`). Click opens Settings and scrolls `#vpn-settings` into view via a 50ms-delayed `scrollIntoView({behavior:"smooth"})` — no hash-routing / no new global store. `pnpm --filter @castcrate/web typecheck` clean. No new lint errors introduced (the 6 pre-existing errors in Player.tsx, SubtitlePicker.tsx, CastControls.tsx, and Settings.tsx line 89 all predate this session). Web package has no `test` script — nothing to run there.

**Persistent-nav path:** `apps/web/src/App.tsx` — the persistent nav is an inline `<nav>` in the single-root `App` component (no separate `TopNav.tsx`); it renders on every route because the app has no router (modals + state-driven views). Question resolved.

- ✅ Phase 4 (code-complete, VM verify pending): `VpnMode` + `VpnHealth` types added to `packages/shared/src/index.ts` (additive-only). `apps/server/src/lib/config.ts` extended with `vpnMode` (default `"off"`, only literal `"vpn"` opts in) and `hostClearnetIp` (nullable). New `apps/server/src/services/vpn-health.ts` exports `getVpnHealth(forceRefresh?)`: short-circuits when `mode!=="vpn"` (no fetch, no `wg` spawn — verified via test), else probes `https://ifconfig.co/json` with 3s `AbortSignal.timeout`, spawns `/usr/bin/wg show wg-castcrate endpoints` (1s timeout, ENOENT-safe on macOS), 30s in-memory cache, failed probes don't overwrite cache. `GET /api/system/vpn-health` (`?refresh=` bypass) added alongside `/api/system/check` in `routes/health.ts` — no auth (matches sibling). `GET /api/settings` response gained `vpnMode` + `vpnConfigured: existsSync("/etc/castcrate/wg0.conf")` (presence-only, never returns WG keys). `.env.example` documents both new envs. 5 new Vitest cases in `services/__tests__/vpn-health.test.ts` (non-leaking, leaking, timeout, off-short-circuit, cache+forceRefresh); 248 tests pass (was 243). `pnpm typecheck` clean. Only VM verification (4.8) remains.

**Path deviation from plan:** the settings surface additions (`vpnMode` + `vpnConfigured`) live in `apps/server/src/routes/health.ts` (where the `/api/settings` GET decoration already happens next to the TorrentDay/Stremio masking), NOT in `services/settings.ts`. The service layer holds the raw `RuntimeSettings` object; the route layer is where masking + surface fields are added. This matches the existing sanitiser/masking convention exactly. `services/settings.ts` was not modified.

**What's Next:**
- 📋 **User browser-verify task 5.6** — load the app locally with `VPN_MODE=off` and confirm the nav pill shows grey OFF + the Settings VPN section renders with the "VPN routing disabled" explainer. Ideally also verify the pill click opens Settings and scrolls the VPN section into view. This is a manual step the user drives.
- 📋 **Phase 7 (real 2011 MBP box)** — copy scripts + units to the deployed box, capture `HOST_CLEARNET_IP`, flip `VPN_MODE=vpn`, verify inside-ns curl + `/api/system/vpn-health` + Chromecast E2E (Interstellar → Master Llama) + TorrentDay non-empty with system VPN off. This is where the full DoD closes.
- 📋 **Phase 6 (kill-switch verification)** — happens on the same real box during Phase 7: `wg-quick down` inside ns while running `tcpdump -i <lan_if>`, trigger an indexer search, confirm zero-leak. All Phase 6 script/unit edits (`run-server.sh` VPN_MODE gate merge, `Requires=` → `Wants=`) are still pending code work — the merge is trivial and the Phase 2 `run-server.sh` already carries the exact insertion marker.

**Blockers:**
- None for user-driven task 5.6. Phase 6 code merges + Phase 7 execution both require the 2011 MBP box (SSH access + physical proximity for lockout recovery).

---

## Key Files

### Core Implementation (all new — nothing exists yet)

**Deploy / ops:**
- `scripts/netns-up.sh` — idempotent netns + veth + WG + exception routes + host DNAT setup (Phase 1).
- `scripts/netns-down.sh` — teardown; safe to run twice (Phase 1).
- `scripts/run-server.sh` — merged trampoline + `VPN_MODE` gate; wraps `ip netns exec` (Phase 2 / Phase 6).
- `deploy/systemd/castcrate-netns.service` — `Type=oneshot`, `RemainAfterExit=yes`, `ConditionPathExists=/etc/castcrate/wg0.conf` (Phase 2).
- `deploy/systemd/castcrate.service` — **edit**: add `After=`/`Wants=` on netns unit; change `ExecStart=` to `run-server.sh` (Phase 2 / Phase 6).

**Server:**
- `apps/server/src/routes/system.ts` — add `GET /api/system/vpn-health` alongside existing `/api/system/check` (Phase 4).
- `apps/server/src/services/vpn-health.ts` — new: probe `ifconfig.co` (inside ns), 30s cache, `wg show` peer parse (Phase 4).
- `apps/server/src/services/settings.ts` — surface `vpnMode` + `vpnConfigured` boolean on settings GET; never returns WG keys (Phase 4).
- `apps/server/src/lib/config.ts` — add `VPN_MODE`, `HOST_CLEARNET_IP`, `CASTCRATE_LAN_IP` envs (Phase 3 / Phase 4).
- `apps/server/src/lib/cast-lan.ts` (or wherever `getLanIp()` lives — verify path) — add `CASTCRATE_LAN_IP` env override so cast URL construction still works inside the ns (Phase 3).
- `apps/server/src/services/__tests__/vpn-health.test.ts` — new; 4 mocked cases (success / leak / timeout / off) (Phase 4).

**Shared:**
- `packages/shared/src/index.ts` — add `VpnMode` + `VpnHealth` types (Phase 4).

**Web:**
- `apps/web/src/lib/api.ts` — add `vpnHealth(refresh?: boolean): Promise<VpnHealth>` (Phase 5).
- `apps/web/src/components/Settings.tsx` — add "Network / VPN" section (Phase 5).
- `apps/web/src/components/TopNav.tsx` (or persistent-nav equivalent) — add status pill visible on every route (Phase 5).
- `apps/web/src/lib/countryFlag.ts` — new; tiny ISO-code → emoji helper (Phase 5).

**Docs:**
- `docs/features/castcrate/media-mac-deploy/tasks.md` — add **Phase 8: VPN split-tunnel** (15 checkable steps); extend Phase 3 apt list with `wireguard-tools iptables-nft` (Phase 7).
- `.env.example` (server) — document `VPN_MODE`, `HOST_CLEARNET_IP`, `CASTCRATE_LAN_IP` (Phase 3 / Phase 4).

### Related Files (read-only reference)

- `docs/features/castcrate/vpn-split-tunnel/requirements.md` — the spec that drives this plan.
- `docs/features/castcrate/vpn-split-tunnel/implementation.md` — full architectural plan (7 phases, 10 decisions, DoD, testing, risks).
- `docs/features/castcrate/epic-overview.md` — this feature is row #20; build-order position after `media-mac-deploy`.
- `docs/features/castcrate/media-mac-deploy/implementation.md` + `context.md` — deploy runbook this feature folds into; source of the systemd sandbox constraints (tilde-footgun, silent-swallow, etc.).
- `docs/features/castcrate/hardening/implementation.md` — security bar this feature must meet (kill-switch, no leaks, `shutdownTranscodes()` ordering).
- `docs/features/castcrate/knaben-fallback/implementation.md` — DNS monkey-patch that must compose with the tunnel (verified in Phase 6).
- `docs/features/castcrate/chromecast/implementation.md` — mDNS + inbound TCP surface that must keep working inside the ns (regression in Phase 3).

---

## Important Decisions

### D1: Whole-server-in-network-namespace, not per-source app routing

**Date:** 2026-08-11
**Context:** Some torrent sources (TorrentDay) return empty without a VPN; others (YTS, Knaben) work on clearnet. The user was manually toggling a system VPN, which breaks Chromecast.
**Decision:** Run the entire Fastify server inside a Linux network namespace (`castcrate-ns`) whose default route is WireGuard. LAN reachability preserved via veth pair + RFC1918 + multicast exception routes + host iptables DNAT for `:3000`.
**Rationale:** OS-layer routing means every existing feature (indexers, torrent DHT, subtitle fetch, metadata) is transparently VPN-routed with **zero application code change**. Per-source `useVpn` flags would create a combinatorial matrix of fragile plumbing across indexer + torrent + metadata paths. Torrent DHT / peer TCP uses `net.Socket` directly and can't be intercepted by an `undici.Agent` anyway.
**Impact:** All the interesting complexity lives in `scripts/netns-up.sh` + `deploy/systemd/*.service`. Application code touched in ≤ 3 files (`vpn-health.ts`, `cast-lan.ts` env override, `config.ts` envs).

### D2: `/api/system/vpn-health` (not top-level `/health/vpn`)

**Date:** 2026-08-11
**Context:** Requirements originally spec'd `/health/vpn`, but the codebase pattern is `/api/system/*` for read-only status endpoints (`/api/system/check` already exists).
**Decision:** Nest under `/api/system/vpn-health`.
**Rationale:** Consistency reduces client-side special-casing and matches what a future engineer would expect.
**Impact:** Client-side `vpnHealth()` in `apps/web/src/lib/api.ts` hits `/api/system/vpn-health`; nothing at the top level.

### D3: `VPN_MODE=off` as a first-class no-op

**Date:** 2026-08-11
**Context:** macOS local dev has no netns; some users may not want VPN routing at all.
**Decision:** `VPN_MODE=off` (or absence of `/etc/castcrate/wg0.conf`) makes `castcrate-netns.service` a no-op via `ConditionPathExists=`. The `run-server.sh` wrapper inspects `VPN_MODE`; when `off`, runs Fastify on the host directly, byte-identical to pre-feature behaviour. `castcrate.service` uses `Wants=` (not `Requires=`) so a missing netns unit doesn't hard-fail Fastify.
**Rationale:** Same systemd unit files ship in both configurations. No two-branch drift.
**Impact:** Every phase preserves the `VPN_MODE=off` regression path. DoD explicitly requires proof of byte-identical pre-feature behaviour with `VPN_MODE=off`.

### D4: `CASTCRATE_LAN_IP` env override

**Date:** 2026-08-11
**Context:** Inside the ns, `os.networkInterfaces()` only sees `lo` + `veth-cc-ns` (`10.200.200.2/30`). `getLanIp()` currently auto-detects and would return `10.200.200.2`, which is unreachable from LAN. Chromecast constructs stream URLs from this value — regression risk.
**Decision:** Introduce `CASTCRATE_LAN_IP` env in `apps/server/src/lib/config.ts`; `getLanIp()` returns it when set, falls through to auto-detect otherwise. Systemd unit `EnvironmentFile=` sets it to the host's real LAN IP (e.g. `192.168.x.y`).
**Rationale:** Deterministic, doesn't break macOS local dev (unset = auto-detect as before), no runtime probing surface.
**Impact:** One env var to document in `.env.example` + one branch in `getLanIp()`. Regression-tested in Phase 3.

### D5: `HOST_CLEARNET_IP` env vs boot-time subprocess auto-detect

**Date:** 2026-08-11
**Context:** `/api/system/vpn-health` needs the host's clearnet IP fingerprint to detect leaks (compare against observed public IP from inside the ns). Options: (a) auto-detect at boot via a host-side subprocess, (b) require the user to set it explicitly.
**Decision:** Env-only in v1 (`HOST_CLEARNET_IP=...`). Runbook Phase 8 instructs the user to `curl -s https://ifconfig.co/ip` on the box *before* enabling the netns and paste the value into `.env`.
**Rationale:** Simpler, deterministic, no subprocess-in-systemd-sandbox surface (the tilde-footgun / silent-swallow class of bugs). Auto-detect can be added later if needed. YAGNI.
**Impact:** One env var to document; one manual runbook step. Leak detection remains reliable.

### D6: `wg-castcrate` lives inside the ns, not on the host

**Date:** 2026-08-11
**Context:** WG interface could technically live on the host with policy routing pushing specific processes through it.
**Decision:** WG interface is created *inside* `castcrate-ns` via `ip netns exec castcrate-ns wg-quick up`.
**Rationale:** Host keeps its clearnet default route on `eth0` untouched — user's SSH sessions, monitoring, and unrelated processes are unaffected. Simpler mental model (netns is the VPN "zone").
**Impact:** `wg show` from Fastify inside the ns works with no privilege escalation. Host processes see zero VPN interference.

### D7: IPv6 explicitly disabled inside the ns (v1)

**Date:** 2026-08-11
**Context:** Dual-stack multiplies the leak surface (a v6 default route could bypass the v4 WG tunnel if misconfigured).
**Decision:** `sysctl -w net.ipv6.conf.{all,default,lo}.disable_ipv6=1` inside the ns during `netns-up.sh`. WG config uses `AllowedIPs = 0.0.0.0/0` (v4 only).
**Rationale:** No v6-only sources in the feature roster. Home network may or may not have working v6 anyway.
**Impact:** `curl -6` inside the ns fails cleanly. `ip -6 addr` shows nothing.

---

## Gotchas & Learnings

### 1. Tilde-footgun in systemd unit files (inherited from `media-mac-deploy`)

**Problem:** `EnvironmentFile=` expands `~` to literal `/home/castcrate/~/…` under sandbox flags (`ProtectHome=read-only`), which then blows up on any file access.
**Solution:** Use absolute paths **everywhere** in unit files, wrapper scripts, and `.env`. Never `~/…`.
**Lesson:** If it looks like a path, spell it out. Verified in Phase 2 DoD (`journalctl` shows no `denied` / `read-only` errors).

### 2. `os.networkInterfaces()` inside a netns only sees `lo` + veth

**Problem:** `getLanIp()` auto-detection returns the veth-ns IP (`10.200.200.2`), which is unreachable from the LAN. Chromecast stream URLs constructed from this value fail silently on the receiver.
**Solution:** `CASTCRATE_LAN_IP` env override (see D4).
**Lesson:** Any code that uses `os.networkInterfaces()` needs an env escape hatch for ns'd deployments. Currently one call site (`getLanIp()`); verify no others crop up during Phase 3.

### 3. `knaben-fallback` DNS monkey-patch composes correctly with the tunnel (no code change)

**Problem (feared):** `knaben-fallback` monkey-patches `dns.lookup` process-wide to Cloudflare (1.1.1.1). Would the ns's routing interfere?
**Solution:** Inside the ns, `1.1.1.1` is not in the RFC1918 exception set → it takes the WG default route → the DNS query exits via the tunnel to the WG peer → the peer forwards to Cloudflare. Verified in Phase 6 with `tcpdump -i <lan_if>` showing zero UDP to `1.1.1.1:53` on the host.
**Lesson:** Document composition, don't silently rely on it. If a future feature adds *another* monkey-patch, sanity-check it under the tunnel.

---

## API Integration

### API Endpoints (new / edited)

- `GET /api/system/vpn-health` — new (Phase 4). Returns `VpnHealth`.
- `GET /api/system/vpn-health?refresh=1` — forces a fresh probe (bypass 30s cache).
- `GET /api/settings` — edited (Phase 4). Adds `vpnMode` + `vpnConfigured` boolean fields. Never returns WG keys.

### Shared Types (new — `packages/shared/src/index.ts`)

```ts
export type VpnMode = "vpn" | "off" | "unknown";

export interface VpnHealth {
  mode: VpnMode;
  publicIp: string | null;
  country: string | null;          // ISO 3166-1 alpha-2
  wgPeer: string | null;           // "host:port" from `wg show`
  reachable: boolean;
  leaking: boolean;                // publicIp === HOST_CLEARNET_IP → true
  lastCheckedAt: number | null;    // unix ms
}
```

### Services Used (external, all via the tunnel)

- **ifconfig.co** (`https://ifconfig.co/json`) — public IP + country lookup for leak detection. 3s timeout. Called from inside the ns; naturally exits via WG.
- **WG peer's DNS forwarder** — implicit, transitive: `dns.lookup` (monkey-patched by `knaben-fallback`) → 1.1.1.1 via WG.

---

## State Management

### Server-side (in-memory)

- `vpn-health.ts` caches the last successful `VpnHealth` for 30s. `?refresh=1` bypasses.
- Boot-time constant: `HOST_CLEARNET_IP` from env; drives `leaking` computation.
- No persistent state in v1. `StateDirectory=castcrate` is provisioned by systemd (Phase 2) as insurance if we later need to persist the boot-time fingerprint.

### Web-side

- `TopNav` pill: `useEffect` + `setInterval(60_000)` polling `vpnHealth()`. React Query if the app already uses it (verify in Phase 5); otherwise plain hooks.
- Settings VPN section: manual "Refresh" button hitting `vpnHealth(true)`.
- No new store; response drives render directly.

---

## Testing Approach

### Unit Tests

- `apps/server/src/services/__tests__/vpn-health.test.ts` — Vitest, mocked `undici` request to `ifconfig.co`:
  - `mode=vpn`, response IP ≠ host IP → `{ leaking: false, reachable: true }`
  - `mode=vpn`, response IP === host IP → `{ leaking: true }`
  - `mode=vpn`, request times out → `{ reachable: false }`
  - `mode=off` → short-circuit; no fetch call issued
  - Cache: second call within 30s hits cache; `?refresh=1` forces fresh fetch

### Integration Tests

- None automated. The netns scripts and end-to-end cast regression are executed manually on a throwaway Ubuntu VM (Phase 1–3) and on the real 2011 MBP box (Phase 7). CI can't allocate a netns.

### Manual Testing Checklist (executed on the deployed box — the DoD verification method)

- [ ] `ip netns exec castcrate-ns curl -s https://ifconfig.co/json | jq .` → VPN IP + country
- [ ] `curl -s https://ifconfig.co/json | jq .` → home clearnet IP
- [ ] From LAN laptop: `http://<box>:3000` loads; nav pill shows green `VPN · <country>`
- [ ] `curl -s http://<box>:3000/api/system/vpn-health | jq .` → correct shape
- [ ] Cast Interstellar → Master Llama; playback starts within 30s
- [ ] TorrentDay search returns non-empty results with system VPN OFF
- [ ] Kill-switch: `wg-quick down` inside ns → search fails; `tcpdump -i <lan_if>` shows zero non-filtered packets; pill flips to UNREACHABLE within 60s
- [ ] Recovery: `wg-quick up` → next search succeeds; pill goes green
- [ ] `VPN_MODE=off` → `castrate-netns.service` inactive; Fastify on host; behaviour byte-identical to pre-feature
- [ ] IPv6: `ip -6 addr` inside ns empty; `curl -6` inside ns fails cleanly
- [ ] `grep -rE "PrivateKey|PresharedKey|wg0\.conf" apps/ packages/ scripts/` returns nothing (no credentials in repo)

---

## Performance Considerations

- **Extra hop for external egress.** All outbound now traverses the tunnel — added latency depends on the WG endpoint location. Typical impact: +20–80ms per external HTTP round-trip. Acceptable for indexer / metadata calls; irrelevant for LAN cast/stream (which never leaves the LAN).
- **`/api/system/vpn-health` caching.** 30s in-memory cache prevents polling from hammering ifconfig.co. UI polls every 60s per nav-pill; well under any rate limit.
- **DNAT overhead.** Kernel `nat/PREROUTING` DNAT is a conntrack table lookup — nanoseconds. No user-space proxy overhead (see Decision #8).
- **No CPU cost for the netns itself.** Namespaces are near-free at the kernel level; the veth pair adds one queue disc but is trivial for LAN throughput.

---

## Next Steps

### Immediate (Today / This Session)

1. Ensure user has (or can obtain) a `wg0.conf` from their provider — pre-req for Phase 1.
2. Spin up a throwaway Ubuntu 26.04 VM (Multipass on macOS is the fastest option).
3. Start Phase 1 tasks — install packages, drop `wg0.conf`, begin drafting `scripts/netns-up.sh`.

### Short Term (This Week)

1. Complete Phase 1 (netns/veth/WG scripts + verified inside-ns/host curl split on the VM).
2. Complete Phase 2 (systemd wiring on the VM; verify ordering, sandbox interaction).
3. Complete Phase 3 (Fastify inside the ns on the VM; verify Chromecast end-to-end).

### Future (After Phase 3)

1. Phase 4 — `/api/system/vpn-health` + shared type + unit tests.
2. Phase 5 — Settings UI panel + nav pill.
3. Phase 6 — kill-switch + `VPN_MODE=off` verification (packet capture on the VM).
4. Phase 7 — Runbook Phase 8 in `media-mac-deploy/tasks.md` + real-box execution.

---

## Open Questions

- [ ] **Q:** Which VPN provider will the user standardise on? (Affects only the sample `wg0.conf` referenced in the runbook — the code is provider-agnostic.)
      **A:** TBD — user's call. Runbook can list Mullvad / PIA / Proton / AirVPN as examples with links to their WG config generators.

- [x] **Q:** Does `apps/web` already use React Query, or should the nav-pill polling use a plain `useEffect` + `setInterval`?
      **A:** Resolved 2026-08-12 (Phase 5): React Query is already a top-level dep (`@tanstack/react-query ^5.62.7`) and every sibling component in `apps/web/src/components/` uses it. The new `VpnStatusPill` uses `useQuery` with `refetchInterval: 60_000` + `refetchOnWindowFocus: false`; the Settings `VpnSection` shares the same `["vpn-health"]` query key so both stay in cache-sync (`qc.setQueryData` on refresh updates both consumers).

- [x] **Q:** Exact file path for `getLanIp()` — does it live at `apps/server/src/lib/cast-lan.ts`, `apps/server/src/services/cast.ts`, or somewhere else?
      **A:** Resolved 2026-08-11 (Phase 3.3): `apps/server/src/lib/network.ts`. Signature `getLanIp(): string | null` (returns `null` when no non-internal IPv4 iface is found; no caching, no throws). Sole call site: `apps/server/src/routes/cast.ts:120`, which already handles the `null` case by 500-ing with an explanatory error — env override slots in cleanly as a pre-check inside `getLanIp()` with no signature change.

- [ ] **Q:** Should `castcrate-netns.service` have `Restart=on-failure` for peer-drop resilience?
      **A:** YAGNI in v1. Add only if the real-box runbook execution reveals a flapping problem.

---

## Session Notes

### 2026-08-11 15:07 — Feature started

- Requirements captured earlier this session; sketched as row #20 of the epic (Platform (planned)).
- Full solution-architect pass completed; 775-line `implementation.md` covers 7 phases, 10 tech decisions, DoD, testing, dependencies, and 9 risks.
- Epic + all 19 sibling features surveyed (via Explore agent); integration points and gotchas folded into the plan (notably: tilde-footgun, `CASTCRATE_LAN_IP` for cast URL construction, `HOST_CLEARNET_IP` env-only vs auto-detect, `knaben-fallback` DNS composes with tunnel).
- Docs scaffolded: `context.md` (this file) and `tasks.md` (49 tasks across 7 phases).
- Next session: Phase 1 — spin up Ubuntu VM, install packages, draft `netns-up.sh`.

### 2026-08-11 15:47 — Phase 2 writable subset landed

- Wrote the three Phase 2 artefacts per implementation.md constraints:
  - `deploy/systemd/castcrate-netns.service` — `Type=oneshot`, `RemainAfterExit=yes`, `ConditionPathExists=/etc/castcrate/wg0.conf` (makes the unit a skip-not-fail no-op when config is missing, enabling clean Decision #7 degradation), no sandbox flags (needs `CAP_NET_ADMIN` + `iptables` + `ip netns` as root). Comment block explicitly warns against future "hardening" attempts.
  - `deploy/systemd/castcrate.service` — starts from the currently-deployed unit (media-mac-deploy tasks.md line 80); adds `After=castcrate-netns.service`, `Requires=castcrate-netns.service` (with a comment noting Phase 6 flips this to `Wants=`), changes `ExecStart=` to `/usr/sbin/ip netns exec castcrate-ns /opt/castcrate/scripts/run-server.sh`, adds `StateDirectory=castcrate` (task 2.4). Preserves every existing sandbox directive verbatim (`NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=/home/castcrate/castcrate-downloads`), `User=castcrate`, `Restart=on-failure`, `EnvironmentFile=/home/castcrate/castcrate/apps/server/.env`. Header comment block calls out the tilde-footgun (media-mac-deploy Bug B) so future readers don't forget `EnvironmentFile=` won't expand `~`.
  - `scripts/run-server.sh` — Phase 2 version: single `exec /usr/bin/node …` after a `[run-server]` startup log line. `set -euo pipefail`, absolute paths only, `chmod 755`. `bash -n` passes. Contains a `# --- Phase 6 will add VPN_MODE gate here ---` marker at the exact insertion point so Phase 6 is a clean single-block edit (wrap the existing exec in an `if [ "${VPN_MODE:-off}" = "vpn" ]; then … else … fi`; the current exec becomes the `off` branch).
- Verification available on macOS: `bash -n` on the script passes; unit files have exactly one `[Unit]`/`[Service]`/`[Install]` each, no trailing whitespace, no CRLF, no tildes or `$HOME` in any directive. `shellcheck` and `systemd-analyze verify` are not available on this workstation — both must be re-run on the Ubuntu VM as part of tasks 2.5–2.7.
- Tasks 2.5, 2.6, 2.7 (deploy to VM, verify boot/teardown ordering, verify sandbox-error-free journal) require a live Ubuntu VM and are out of scope for this session — they are runbook steps for the user.

### 2026-08-11 17:04 — Multipass VM verification session (partial success, hardware pivot)

**Setup.** Multipass on macOS (`multipass launch 24.04 --name cc-vpn --cpus 2 --memory 4G --disk 20G --bridged` after `multipass set local.bridged-network=en0`). VM came up with dual interfaces: `enp0s1` NAT (192.168.252.2) + `enp0s2` bridged to Wi-Fi (192.168.1.195, same subnet as user's Deco/Chromecast LAN). Packages installed cleanly (`wireguard-tools iproute2 iptables curl jq python3 shellcheck`). Note: `iptables-nft` is not a separate package on Ubuntu 24.04+ — `iptables` itself ships with the nft backend as default. `iptables v1.8.10 (nf_tables)` verified. IPVanish Amsterdam WG config (`ams-c45.ipvanish.com` → 205.185.199.29:51820) dropped at `/etc/castcrate/wg0.conf` mode 600 root:root.

**What worked (validated in isolation on Ubuntu 24.04):**
- `shellcheck /opt/castcrate/scripts/*.sh` — **clean** across all three scripts.
- `netns-up.sh` — ran cleanly end-to-end. All 18 log lines green. Every step landed as designed: namespace created, veth pair created + moved, IPs assigned, IPv6 disabled inside ns, WG interface created on host + moved into ns (`wg-castcrate`), config applied via `wg setconf` (correctly stripping DNS/Address lines via `wg-quick strip`), address `100.96.0.176/32` assigned, four exception routes added, `default dev wg-castcrate` default route added, host `iptables -t nat DNAT` rule added.
- Socket namespace verification: `ss -uapn | grep 56501` in host ns shows the WG UDP socket (0.0.0.0:56501); in `castcrate-ns` it shows nothing. Script's "create on host, move to ns" pattern **correct**.
- `netns-down.sh` — ran cleanly, removed DNAT rule, deleted WG interface, deleted veth pair, deleted namespace.
- Systemd units — transferred, `systemctl daemon-reload` clean, `castcrate-netns.service` enabled + started without error.

**What could not be validated on Multipass:**
- **WG handshake never completed.** `wg show` reported `transfer: 0 B received, N B sent` even after multiple retry cycles + persistent-keepalive. Peer IP (205.185.199.29) reachable via ICMP (~240ms Sydney→US). Basic UDP outbound works from the VM (DNS to 8.8.8.8 succeeded via both interfaces). Yet zero response packets returned for WG.
- **Ruled out our scripts.** A plain `wg-quick up wg0` on the host (outside our netns entirely, no scripts involved) exhibited **identical symptoms** — interface up, config applied, zero handshake response.
- **Ruled out the WG config.** IPVanish's DNS for the endpoint hostname resolves to the same IP the config uses. Config shape is correct (`AllowedIPs = 0.0.0.0/0`, single-address `100.96.0.176/32`).
- **Root cause: Multipass on macOS.** QEMU's user-mode NAT (SLIRP) + vmnet-bridged on macOS Wi-Fi has known, well-documented issues with WireGuard's UDP flow pattern. `enp0s2` (bridge) showed `RX dropped: 9450/10536` (~90% packet loss) — vmnet-bridged over Wi-Fi drivers is unreliable on macOS. Not a fixable problem within Multipass.

**Decision.** Do not spend further session tokens on this VM. All script logic, systemd unit syntax, package installs, code integration, and shellcheck are validated. The one thing left — actual WG tunnel traffic + Chromecast E2E — needs real Linux hardware; the 2011 MBP box is the intended target for that (Phase 7). Multipass was insurance; the insurance caught zero code-level bugs, which is a genuinely positive result.

**Alternative VMs considered and rejected for this session:** UTM (would need another 30+ min of setup + same networking uncertainty), Docker-based Linux (nesting namespaces on Docker Desktop's LinuxKit VM is a mess), spinning up a real Ubuntu box (user does not currently have one accessible other than the 2011 MBP itself).

**Tasks marked complete this session:** 1.1, 1.2, 1.3, 1.8 (plus 1.4, 1.5 already done). Tasks 1.6, 1.7 marked ⏸️ blocked on Multipass, deferred to Phase 7. Tasks 2.5–2.7 remain unchecked — daemon-reload validated on the VM but full boot-ordering + Fastify-in-ns validation deferred alongside 1.6.

**Path forward:** Phase 5 (UI code — no VM required) next. Phase 7 (real 2011 MBP box) closes the DoD.

---

### 2026-08-12 09:12 — Phase 5 UI landed

- Wired `vpnHealth(refresh?: boolean)` into `apps/web/src/lib/api.ts` (matches the existing URL + `request<T>()` client style — no bespoke fetch, no new error class).
- New `apps/web/src/lib/countryFlag.ts` — 11-line ISO-alpha-2 → emoji helper, degrades to `""` on bad input.
- New "Network / VPN" section in `Settings.tsx`, positioned directly above the "Indexers — Private Trackers" block (grepped for the exact anchor text; that's the section immediately below the Public-Indexers block). Uses the same rounded-xl card styling (`rounded-xl border border-zinc-800 bg-zinc-900/40 p-4`) as every sibling section. Badge component matches the app's inline-pill vernacular (rounded-full + colored border/bg/text). `role="status"` + `aria-label` on the badge; refresh button has `aria-label="Refresh VPN health"`. `id="vpn-settings"` + `scroll-mt-8` on the section for deep-linking.
- New `apps/web/src/components/VpnStatusPill.tsx` — added at the end of the inline `<nav>` in `App.tsx`. Uses React Query with `refetchInterval: 60_000` (no ad-hoc setInterval). Colored dot + label — `VPN · XX` green / `LEAK` red (with `animate-pulse`) / `OFF` grey / `?` amber. Click callback opens Settings and scrolls `#vpn-settings` into view after a 50ms delay so the modal has time to mount. Rendered as a `<button>` with aria-label describing state + exit country.
- `pnpm --filter @castcrate/web typecheck` clean. No new lint errors (6 pre-existing errors in Player/SubtitlePicker/CastControls/Settings line 89 unchanged). Web package has no `test` script.
- **Deviation from spec:** the Settings VPN section renders `Peer: —` line separately (below the dl) rather than inline in the exit-IP layout, to match the visual hierarchy of the surrounding cards (bullet-hint style). All spec fields present.
- **Persistent-nav resolution:** there is no separate `TopNav` — nav lives inline in `App.tsx`. Documented above.

---

*Update this file at the end of each work session. Run `/update-feature castcrate/vpn-split-tunnel` before compacting conversations.*
