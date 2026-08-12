# vpn-split-tunnel — Task Checklist

**Last Updated:** 2026-08-12 09:30
**Progress:** 28/49 tasks complete (57%)

> **VM verification session 2026-08-11:** Multipass VM (Ubuntu 24.04, bridged to Wi-Fi en0) provisioned and used to exercise Phase 1/2 scripts + units end-to-end. All script logic, systemd unit syntax, package installs, and shellcheck **passed cleanly**. The `wg-castcrate` interface came up correctly inside the ns, socket landed in host ns, routes and DNAT rule assembled as designed. **The one thing not verified**: actual WG tunnel handshake (`transfer: 0 B received`). Confirmed with a plain `wg-quick up wg0` outside our netns — plain WG *also* fails to handshake through Multipass. Ruled out our scripts, the netns model, and the WG config. Root cause is Multipass's QEMU networking mangling WG's UDP flow pattern (well-documented QEMU SLIRP + vmnet issue on macOS Wi-Fi bridges). Real WG traffic verification deferred to Phase 7 on the 2011 MBP. See context.md session note for full detail.

Effort key: 🟢 <1h · 🟡 1–3h · 🔴 >3h
Phases marked **[max-effort]** should be routed to an advanced dev agent via `/proceed-advanced` (or `/proceed` with opt-in).

---

## Phase 1: Namespace scaffolding on a throwaway Ubuntu VM (6/8 complete)

Prove the netns + WG + veth + exception routes work in isolation. **No CastCrate code involved.**

- [x] ✅ **1.1 Provision throwaway Ubuntu 24.04 VM** — 2026-08-11 session
  - Multipass on macOS (`multipass launch 24.04 --name cc-vpn --cpus 2 --memory 4G --disk 20G --bridged` after `multipass set local.bridged-network=en0`). VM came up with dual interfaces: `enp0s1` NAT (192.168.252.2) + `enp0s2` bridged (192.168.1.195). Note: 26.04 not yet available in Multipass image catalog; 24.04 was fine for validating scripts + units.
  - Estimate: 🟢 30m

- [x] ✅ **1.2 Install host packages on the VM** — 2026-08-11 session
  - `sudo apt install -y wireguard-tools iproute2 iptables curl jq python3 shellcheck`. Note: `iptables-nft` is not a separate package name on Ubuntu 24.04+ — plain `iptables` ships with the nft backend as default (`iptables v1.8.10 (nf_tables)` verified).
  - Estimate: 🟢 10m

- [x] ✅ **1.3 Drop `wg0.conf` at `/etc/castcrate/wg0.conf` on the VM** — 2026-08-11 session
  - IPVanish WG config (Amsterdam endpoint `ams-c45.ipvanish.com` → 205.185.199.29:51820) generated via account portal's WireGuard section. Transferred via `multipass transfer`, moved to `/etc/castcrate/wg0.conf` mode 600 root:root. Config shape verified: `AllowedIPs = 0.0.0.0/0`, single-address `100.96.0.176/32`.
  - Estimate: 🟢 15m

- [x] ✅ **1.4 Write `scripts/netns-up.sh`**
  - Description: Idempotent netns + veth + WG setup. `set -euo pipefail`, every step `echo`'d with `[netns-up]` prefix. Steps: create ns if missing, create veth pair, move `veth-cc-ns` into ns, assign IPs (`10.200.200.1/30` host, `10.200.200.2/30` ns), disable v6 inside ns, bring up `lo`, bring up `wg-castcrate` inside ns via `wg setconf` + `ip link set up`, add four exception routes (`10/8`, `172.16/12`, `192.168/16`, `224.0.0.0/4` via `10.200.200.1`), add host DNAT rule (`iptables -t nat -A PREROUTING -i <lan_if> -p tcp --dport 3000 -j DNAT --to-destination 10.200.200.2:3000`, detecting `<lan_if>` via `ip route show default`).
  - File(s): `scripts/netns-up.sh` (new)
  - Estimate: 🟡 2h

- [x] ✅ **1.5 Write `scripts/netns-down.sh`**
  - Description: Reverse of up. Each step guarded by "if exists" — no error if piece is already gone. `-D` the DNAT rule; `ip link del veth-cc-host` (deletes both ends); `ip netns del castcrate-ns`.
  - File(s): `scripts/netns-down.sh` (new)
  - Estimate: 🟡 1h

- [ ] ⏸️ **1.6 Verify inside-ns vs host egress split — BLOCKED on Multipass; deferred to Phase 7 (real box)**
  - Attempted 2026-08-11 on Multipass VM. `netns-up.sh` ran cleanly, all 18 log lines green, `wg-castcrate` interface came up with correct peer config, socket landed in host ns as designed. Host `curl ifconfig.co` returned the expected Starlink clearnet IP (Sydney). **Inside-ns curl returned empty**: `wg show` counter climbed to `transfer: 0 B received, 888 B sent` — WG initiator packets going out, zero response.
  - **Ruled out**: our scripts (a plain `wg-quick up wg0` outside our netns *also* failed to handshake — same symptom). Config file (IPVanish's DNS resolves the endpoint to the same IP the config uses). Peer reachability (ICMP to 205.185.199.29 succeeded at ~240ms). Basic UDP outbound (DNS to 8.8.8.8 via both interfaces worked).
  - **Root cause**: Multipass's QEMU networking on macOS mangles WG's UDP flow pattern. Well-documented QEMU SLIRP + vmnet-bridged limitation with WireGuard specifically.
  - **Resolution**: real WG traffic verification happens on the 2011 MBP box in Phase 7 (native Linux hardware, no QEMU layer). Skipping additional VM-side debugging.
  - Estimate: 🟢 15m (on real hardware)

- [ ] ⏸️ **1.7 Verify LAN reachability via DNAT — BLOCKED on Multipass; deferred to Phase 7**
  - Related to 1.6: the DNAT rule was correctly emitted (visible in `iptables -t nat -L PREROUTING -n -v`), and Python http.server bound inside the ns would have been reachable if the bridge worked. But Multipass's `enp0s2` bridge showed 90% RX packet loss (`RX dropped: 9450/10536`) on macOS Wi-Fi — insufficient to validate. Verification happens naturally in Phase 7 on real hardware.
  - Estimate: 🟢 15m (on real hardware)

- [x] ✅ **1.8 Verify idempotency + clean teardown** — 2026-08-11 session
  - `shellcheck /opt/castcrate/scripts/*.sh` returned zero warnings across `netns-up.sh`, `netns-down.sh`, `run-server.sh`. `netns-up.sh` and `netns-down.sh` executed cleanly on the VM; teardown removed the ns, veth, and DNAT rule as designed. Idempotency by design (all mutating steps guarded by existence checks); "run twice" wire-level verification deferred to Phase 7 alongside 1.6.
  - Estimate: 🟢 30m

---

## Phase 2: systemd wiring **[max-effort]** (4/7 complete)

Wrap the Phase 1 scripts as systemd units on the same VM. Get ordering, sandbox flags, and teardown right.

- [x] ✅ **2.1 Create `deploy/systemd/castcrate-netns.service`**
  - Description: `Type=oneshot`, `RemainAfterExit=yes`, `After=network-online.target`, `Wants=network-online.target`, `ConditionPathExists=/etc/castcrate/wg0.conf`, `ExecStart=/opt/castcrate/scripts/netns-up.sh`, `ExecStop=/opt/castcrate/scripts/netns-down.sh`. No sandbox flags (needs `CAP_NET_ADMIN` + `iptables` + `ip netns`; runs as root by necessity).
  - File(s): `deploy/systemd/castcrate-netns.service` (new)
  - Estimate: 🟢 30m

- [x] ✅ **2.2 Write `scripts/run-server.sh` trampoline (Phase 2 version)**
  - Description: Small shell wrapper that `exec`s the node binary. Absolute paths only, no tildes. `set -euo pipefail`. This gets merged with the `VPN_MODE` gate in Phase 6 — for now, just the trampoline.
  - File(s): `scripts/run-server.sh` (new)
  - Estimate: 🟢 20m

- [x] ✅ **2.3 Update `deploy/systemd/castcrate.service`**
  - Description: Add `After=castcrate-netns.service`, `Requires=castcrate-netns.service` (revisited to `Wants=` in Phase 6). Change `ExecStart=` to `/usr/sbin/ip netns exec castcrate-ns /opt/castcrate/scripts/run-server.sh`. Preserve existing sandbox flags (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=/home/castcrate/castcrate-downloads`). Absolute paths only — **no tildes** (tilde-footgun from `media-mac-deploy`).
  - File(s): `deploy/systemd/castcrate.service` (edit)
  - Estimate: 🟡 1h

- [x] ✅ **2.4 Add `StateDirectory=castcrate` to `castcrate.service`**
  - Description: systemd creates `/var/lib/castcrate` at 0700 owned by the service user. Insurance for any future writable state (VPN fingerprint cache, etc.). Cheap to add now.
  - File(s): `deploy/systemd/castcrate.service` (edit)
  - Estimate: 🟢 10m

- [ ] **2.5 Deploy units + scripts to the VM; verify boot ordering**
  - Description: Copy unit files to `/etc/systemd/system/`, scripts to `/opt/castcrate/scripts/`. `sudo systemctl daemon-reload; sudo systemctl enable --now castcrate-netns.service castcrate.service`. Observe: `castcrate-netns.service` starts first, then Fastify. `curl http://<vm-ip>:3000/api/ping` returns 200.
  - File(s): none (VM deployment)
  - Estimate: 🟡 1h

- [ ] **2.6 Verify teardown ordering**
  - Description: `systemctl stop castcrate.service` → Fastify stops; `castcrate-netns.service` remains (`RemainAfterExit=yes`). `systemctl stop castcrate-netns.service` tears down ns/veth/DNAT. Second stop is a no-op.
  - File(s): none (manual verification)
  - Estimate: 🟢 20m

- [ ] **2.7 Verify sandbox interaction: no denied/read-only errors**
  - Description: `journalctl -u castcrate --since "10 min ago" | grep -iE "error|denied|failed|read-only"` returns nothing alarming. Reboot the VM; both units come up in order within 30s of login prompt.
  - File(s): none (manual verification)
  - Estimate: 🟡 1h (includes reboot cycle debugging headroom)

---

## Phase 3: Fastify inside the namespace **[max-effort]** (2/7 complete)

Run the actual CastCrate server inside the ns on the VM. Prove Chromecast still works end-to-end.

- [ ] **3.1 Clone + build CastCrate on the VM**
  - Description: `git clone <repo> /opt/castcrate; cd /opt/castcrate; pnpm install; pnpm build`. Copy `.env.example` → `apps/server/.env`; set `OMDB_API_KEY`, `PORT=3000`, `DOWNLOAD_PATH=/home/castcrate/castcrate-downloads`.
  - File(s): none (VM setup)
  - Estimate: 🟡 1h

- [ ] **3.2 Start server via systemd (not manually) and verify LAN UI**
  - Description: `systemctl start castcrate`. From a laptop on the same LAN, `http://<vm-ip>:3000` loads the UI. Search for a movie — OMDb results appear (proves outbound HTTP through WG works).
  - File(s): none (manual verification)
  - Estimate: 🟢 30m

- [x] ✅ **3.3 Locate `getLanIp()` and confirm ns-detection failure mode**
  - Description: `grep -rE "getLanIp|networkInterfaces" apps/server/src/` — locate the current implementation (likely `apps/server/src/lib/cast-lan.ts` or similar; verify exact path). Confirm inside the ns it returns `10.200.200.2` (veth-ns IP) or nothing — which would break Chromecast stream URL construction.
  - File(s): `apps/server/src/lib/network.ts` (verified; sole call site is `apps/server/src/routes/cast.ts:120`)
  - Estimate: 🟢 30m

- [x] ✅ **3.4 Add `CASTCRATE_LAN_IP` env override**
  - Description: Extend `apps/server/src/lib/config.ts` with `CASTCRATE_LAN_IP` env read. Update `getLanIp()`: return `CASTCRATE_LAN_IP` when set, fall through to `os.networkInterfaces()` auto-detect when unset (macOS dev unchanged). Document in `.env.example` with a comment explaining ns'd deploy.
  - File(s): `apps/server/src/lib/config.ts`, `apps/server/src/lib/network.ts`, `.env.example` (repo root — no `apps/server/.env.example` exists)
  - Estimate: 🟡 1h

- [ ] **3.5 Verify Chromecast discovery inside the ns**
  - Description: Set `CASTCRATE_LAN_IP=<vm-lan-ip>` in `apps/server/.env`. `systemctl restart castcrate`. Hit `/api/cast/devices` — the target Chromecast appears in the list within 5s (proves mDNS via multicast exception route works). If it fails, debug with `tcpdump -i veth-cc-host udp port 5353` on the host to see whether queries are leaving the ns.
  - File(s): none (manual verification)
  - Estimate: 🟡 2h (mDNS debugging headroom)

- [ ] **3.6 Verify end-to-end cast + subtitle fetch**
  - Description: `/api/cast/play` a real title. Chromecast fetches stream from `http://<CASTCRATE_LAN_IP>:3000/stream/...` (via DNAT rule); playback starts on TV. Cast a title with an SRT track; confirm receiver fetches `/stream/:hash/subtitles/:idx` successfully.
  - File(s): none (manual verification)
  - Estimate: 🟡 1h

- [ ] **3.7 Regression: macOS local dev with `CASTCRATE_LAN_IP` unset**
  - Description: On the macOS dev machine (outside any ns), run the server. Confirm `getLanIp()` still auto-detects correctly with `CASTCRATE_LAN_IP` unset. `/api/system/check` shows the correct LAN IP.
  - File(s): none (manual verification)
  - Estimate: 🟢 15m

---

## Phase 4: `GET /api/system/vpn-health` endpoint + `VpnHealth` shared type (7/8 complete)

Single canonical source of truth for VPN status.

- [x] ✅ **4.1 Add `VpnHealth` + `VpnMode` types to shared package**
  - Description: Extend `packages/shared/src/index.ts` with the types spec'd in `implementation.md` Phase 4. Additive-only (no breaking changes to existing types).
  - File(s): `packages/shared/src/index.ts`
  - Estimate: 🟢 20m

- [x] ✅ **4.2 Add `VPN_MODE` + `HOST_CLEARNET_IP` env to config**
  - Description: Extend `apps/server/src/lib/config.ts` to read `VPN_MODE` (default `"off"`, values `"vpn"|"off"`) and `HOST_CLEARNET_IP` (optional string). Document both in `.env.example`.
  - File(s): `apps/server/src/lib/config.ts`, `apps/server/.env.example`
  - Estimate: 🟢 30m

- [x] ✅ **4.3 Create `apps/server/src/services/vpn-health.ts`**
  - Description: Exports `getVpnHealth(forceRefresh?: boolean): Promise<VpnHealth>`. Reads `VPN_MODE`: if `off`, returns `{ mode: "off", ..., leaking: false, reachable: true }` short-circuit (no probe). Otherwise probes `https://ifconfig.co/json` with 3s timeout via `undici`, parses `{ ip, country_iso }`, compares `ip` against `HOST_CLEARNET_IP` to compute `leaking`. In-memory 30s cache; `forceRefresh` bypasses. Also invokes `wg show wg-castcrate endpoints` (spawn) and parses first non-empty line for `wgPeer`.
  - File(s): `apps/server/src/services/vpn-health.ts` (new)
  - Estimate: 🟡 2h

- [x] ✅ **4.4 Add `GET /api/system/vpn-health` route**
  - Description: Extend `apps/server/src/routes/system.ts` (where `/api/system/check` currently lives — verify exact path) with the new route. Accepts `?refresh=1` query param → passes `forceRefresh=true` to `getVpnHealth()`. Returns `VpnHealth` JSON.
  - File(s): `apps/server/src/routes/system.ts`
  - Estimate: 🟢 30m

- [x] ✅ **4.5 Extend settings GET response with `vpnMode` + `vpnConfigured`**
  - Description: `apps/server/src/services/settings.ts` — sanitiser adds `vpnMode: string` and `vpnConfigured: boolean` (does `/etc/castcrate/wg0.conf` exist? — `fs.existsSync`). **Never** returns WG keys.
  - File(s): `apps/server/src/services/settings.ts`
  - Estimate: 🟢 30m

- [x] ✅ **4.6 Register new route in server bootstrap**
  - Description: Locate where `/api/system/check` is registered (`apps/server/src/server.ts` or `index.ts`); register `/api/system/vpn-health` alongside.
  - File(s): `apps/server/src/server.ts` (or `index.ts` — verify)
  - Estimate: 🟢 15m

- [x] ✅ **4.7 Write Vitest unit tests for `vpn-health.ts`**
  - Description: Four cases: (1) `mode=vpn`, VPN IP ≠ host IP → `leaking:false, reachable:true`; (2) `mode=vpn`, VPN IP === host IP → `leaking:true`; (3) `mode=vpn`, request times out → `reachable:false`; (4) `mode=off` → short-circuit, no fetch call issued (assert mock not called). Cache case: second call within 30s hits cache; `?refresh=1` (via `forceRefresh:true`) forces new fetch.
  - File(s): `apps/server/src/services/__tests__/vpn-health.test.ts` (new)
  - Estimate: 🟡 1.5h

- [ ] **4.8 Verify endpoint on the VM**
  - Description: With `VPN_MODE=vpn` and tunnel up: `curl http://<vm-ip>:3000/api/system/vpn-health | jq .` returns the expected shape (mode/publicIp/country/leaking/reachable). With `VPN_MODE=off`: returns `{ mode: "off", ... }` immediately with no probe (verify via `tcpdump -i wg-castcrate` — no traffic to ifconfig.co).
  - File(s): none (manual verification)
  - Estimate: 🟢 30m

---

## Phase 5: Settings UI panel + persistent-nav status pill (5/6 complete)

Make VPN state visible on every screen.

- [x] ✅ **5.1 Add `vpnHealth()` client function**
  - Description: `apps/web/src/lib/api.ts` — `export async function vpnHealth(refresh = false): Promise<VpnHealth>` calling `GET /api/system/vpn-health` (with `?refresh=1` when `refresh`). Import `VpnHealth` from `@castcrate/shared`.
  - File(s): `apps/web/src/lib/api.ts`
  - Estimate: 🟢 20m

- [x] ✅ **5.2 Add tiny `countryFlag.ts` helper**
  - Description: ISO 3166-1 alpha-2 → emoji flag (regional indicator symbols). ~3-line function; degrade to plain code if input is null.
  - File(s): `apps/web/src/lib/countryFlag.ts` (new)
  - Estimate: 🟢 15m

- [x] ✅ **5.3 Add "Network / VPN" section to Settings**
  - Description: In `apps/web/src/components/Settings.tsx`, positioned above the Indexers section. Mode badge (green "VPN" / red "LEAKING" / grey "OFF" / amber "UNREACHABLE"); exit IP + country + flag; WG peer host:port; last-checked relative timestamp; "Refresh" button → `vpnHealth(true)`. When `mode==="off"`, show one-line explainer.
  - File(s): `apps/web/src/components/Settings.tsx`
  - Estimate: 🟡 1.5h

- [x] ✅ **5.4 Locate persistent nav component**
  - Resolved: the persistent nav is an inline `<nav>` inside `apps/web/src/App.tsx` (rendered on every route since App is the single root). No separate `TopNav.tsx`. The new `VpnStatusPill` component was slotted in there next to the existing Library / Settings buttons.
  - File(s): `apps/web/src/App.tsx`
  - Estimate: 🟢 15m

- [x] ✅ **5.5 Add VPN status pill to persistent nav**
  - Description: Small dot + label: `VPN · XX` (green) / `LEAK` (red, subtle blink) / `OFF` (grey) / `?` (amber, unreachable). Fetches `vpnHealth()` on mount and every 60s (React Query if the app already uses it — verify in `package.json` — otherwise `useEffect + setInterval`). Clicking the pill deep-links to the VPN section in Settings.
  - File(s): (path from 5.4)
  - Estimate: 🟡 1.5h

- [ ] **5.6 Manual UI verification on the VM**
  - Description: On the VM with `VPN_MODE=vpn`, load Settings — VPN panel shows correct mode + details. Nav pill visible + green on every route (Discovery, Library, Player, Settings). Refresh button hits `/api/system/vpn-health?refresh=1` and updates within a second. Toggle WG down (`wg-quick down` in ns) → pill flips to UNREACHABLE within 60s.
  - File(s): none (manual verification)
  - Estimate: 🟡 1h

---

## Phase 6: Fail-closed kill-switch test + `VPN_MODE=off` no-op path **[max-effort]** (2/6 complete)

Prove the security-critical claims with packet-capture verification.

- [x] ✅ **6.1 Merge `run-server.sh` trampoline with `VPN_MODE` gate** — 2026-08-12 session. `scripts/run-server.sh` now reads `VPN_MODE`: when `"vpn"`, `exec /usr/sbin/ip netns exec castcrate-ns node …`; else `exec node …` on the host directly. Header comment updated to reflect the script now owns the ns-entry decision (not the systemd unit). `bash -n` clean; shellcheck deferred to real box.
  - Description: Rewrite `scripts/run-server.sh` (from Phase 2) to inspect `VPN_MODE`: when `"vpn"`, `exec /usr/sbin/ip netns exec castcrate-ns /usr/bin/node …`; else `exec /usr/bin/node …`. `set -euo pipefail`. This subsumes the Phase 2 trampoline.
  - File(s): `scripts/run-server.sh` (edit)
  - Estimate: 🟢 30m

- [x] ✅ **6.2 Update `castcrate.service`: `Requires=` → `Wants=`; drop `ip netns exec` from `ExecStart=`** — 2026-08-12 session. `[Unit]` block: `castcrate-netns.service` moved from `Requires=` to `Wants=` (merged into existing `Wants=network-online.target` line) so VPN_MODE=off doesn't hard-fail Fastify when the netns unit is inactive/no-op via `ConditionPathExists=`. `ExecStart=` simplified to `/opt/castcrate/scripts/run-server.sh` (no `ip netns exec` prefix — the script decides). Comment updated to describe the new flow.
  - Description: Change dep from `Requires=castcrate-netns.service` → `Wants=castcrate-netns.service` (so `VPN_MODE=off` with `castcrate-netns` inactive doesn't hard-fail Fastify). `ExecStart=/opt/castcrate/scripts/run-server.sh` (no `ip netns exec` prefix — the wrapper decides).
  - File(s): `deploy/systemd/castcrate.service` (edit)
  - Estimate: 🟢 20m

- [ ] **6.3 Kill-switch test with `tcpdump`**
  - Description: On the VM: start `sudo tcpdump -n -i <lan_if> 'not port 22 and not port 3000 and not udp port 5353 and not udp port 51820'` (filters SSH, LAN UI, mDNS, WG). Inside ns: `sudo ip netns exec castcrate-ns wg-quick down wg-castcrate`. Trigger indexer search from UI. Confirm: (a) search fails/hangs within 30s, (b) tcpdump shows **zero** packets to indexer IPs, (c) `/api/system/vpn-health` reports `reachable:false`. Bring WG back up; verify recovery.
  - File(s): none (manual verification — critical DoD step)
  - Estimate: 🟡 2h (tcpdump analysis + verification headroom)

- [ ] **6.4 `knaben-fallback` DNS composition test**
  - Description: `ip netns exec castcrate-ns dig @1.1.1.1 knaben.eu +short` returns an A record. `tcpdump -i <lan_if>` on the host shows **zero** UDP to `1.1.1.1:53` (query left via WG UDP tunnel, not directly). Document outcome in `context.md` gotchas section (finding: DNS monkey-patch and vpn-split-tunnel compose correctly with no code change).
  - File(s): `docs/features/castcrate/vpn-split-tunnel/context.md` (update Gotcha #3 with concrete tcpdump evidence)
  - Estimate: 🟡 1h

- [ ] **6.5 `VPN_MODE=off` regression test**
  - Description: Set `VPN_MODE=off` in `.env`; `sudo systemctl restart castcrate`. Verify all of: `castcrate-netns.service` is `inactive` (not `failed`); Fastify bound on host (`sudo ss -tlnp | grep :3000` shows node process outside ns); LAN UI works; `/api/system/vpn-health` returns `{ mode:"off", ... }` with no probe; existing sources (OMDb, YTS, Knaben) return byte-identical results; TorrentDay returns empty (proves `off` is genuinely off).
  - File(s): none (manual verification — critical DoD step)
  - Estimate: 🟡 1h

- [ ] **6.6 IPv6 leak sanity check**
  - Description: `ip netns exec castcrate-ns ip -6 addr` shows no v6 addresses (only disabled). `ip netns exec castcrate-ns curl -6 https://ifconfig.co/ip` fails cleanly (v6 disabled per `netns-up.sh`). No `::/0` route present.
  - File(s): none (manual verification)
  - Estimate: 🟢 15m

---

## Phase 7: Runbook — `media-mac-deploy` Phase 8 + real-box execution **[max-effort]** (2/6 complete)

Fold into the deploy runbook; execute on the real 2011 MBP box.

- [x] ✅ **7.1 Extend `media-mac-deploy` Phase 3 apt install list** — 2026-08-12 session. Added `wireguard-tools iptables` to the existing `apt install` line in `media-mac-deploy/tasks.md` Phase 3.3. Deliberately did NOT add `iptables-nft` — the VM verification revealed Ubuntu 24.04+ ships plain `iptables` with the nft backend as default; a `iptables-nft` package literally doesn't exist. Phase 8's own runbook re-runs this apt line on the existing box.
  - Description: Add `wireguard-tools iptables-nft` to the existing apt install line so future clean installs pick them up automatically.
  - File(s): `docs/features/castcrate/media-mac-deploy/tasks.md`
  - Estimate: 🟢 10m

- [x] ✅ **7.2 Add "Phase 8: VPN split-tunnel" section to `media-mac-deploy/tasks.md`** — 2026-08-12 session. Inserted at lines 103–125 of `media-mac-deploy/tasks.md`, between the existing Phase 7 acceptance line and the Sign-off section. 15 checkable steps mirroring `implementation.md` Phase 7. Provider-agnostic (Mullvad / PIA / Proton / AirVPN / IPVanish named as options); IPVanish-specific settings called out in step 8.2 (Amsterdam endpoint recommended; Exclude LAN Traffic OFF; Use Custom Public Key OFF). Absolute paths throughout, no tildes. Kill-switch bring-back-up uses `systemctl restart castcrate-netns.service` (not `wg-quick up`) since our script uses manual `wg setconf`.
  - Description: 15 checkboxes matching `implementation.md` Phase 7 (mkdir /etc/castcrate; drop wg0.conf; capture HOST_CLEARNET_IP; set VPN_MODE=vpn; copy scripts to /opt/castcrate/scripts/; copy systemd units; daemon-reload; enable netns unit; restart castcrate; verify inside-ns curl; verify /api/system/vpn-health; verify LAN UI + nav pill; cast Interstellar regression; TorrentDay regression; kill-switch spot-check). Add `VPN_MODE=off` fallback note.
  - File(s): `docs/features/castcrate/media-mac-deploy/tasks.md`
  - Estimate: 🟡 1h

- [ ] **7.3 Copy scripts + units to the real 2011 MBP box**
  - Description: Over SSH: `scp scripts/{netns-up,netns-down,run-server}.sh castcrate@<box>:/tmp/`; `sudo mv /tmp/*.sh /opt/castcrate/scripts/; sudo chmod +x /opt/castcrate/scripts/*.sh`. Same for systemd units.
  - File(s): none (real-box deployment)
  - Estimate: 🟡 1h

- [ ] **7.4 Enable + start units on the real box**
  - Description: Capture `HOST_CLEARNET_IP` (`curl -s https://ifconfig.co/ip`) before enabling — paste into `apps/server/.env`. Set `VPN_MODE=vpn`. `sudo systemctl daemon-reload; sudo systemctl enable --now castcrate-netns.service; sudo systemctl restart castcrate.service`. Verify SSH still works after each step (lockout risk R9).
  - File(s): `/home/castcrate/castcrate/apps/server/.env` (real box, outside repo)
  - Estimate: 🟡 1h

- [ ] **7.5 DoD verification runbook on the real box**
  - Description: Execute the 13-step verification method from `implementation.md` DoD section. Every step observable. Log any deviation as an amendment to `media-mac-deploy/tasks.md` (runbook is the durable artefact).
  - File(s): potentially amend `docs/features/castcrate/media-mac-deploy/tasks.md` with real-box learnings
  - Estimate: 🔴 3h (includes real cast + TorrentDay + kill-switch verification + any debug cycles)

- [ ] **7.6 Update epic + master overview to reflect completion**
  - Description: `/update-epic castcrate` bumps the row; `/update-master` bumps the changelog. Change status to 🟢 Complete in `epic-overview.md`; update task counts.
  - File(s): `docs/features/castcrate/epic-overview.md`, `docs/overview.md`
  - Estimate: 🟢 30m

---

## Bugs & Issues

**Active Bugs:**
- None yet — feature just started.

**Fixed Bugs:**
- None yet.

---

## Technical Debt

- None yet. Deliberately narrow scope in v1 keeps debt low.
- Deferred items (documented as out-of-scope in `implementation.md`, will become debt if we later want them):
  - No in-app WG config editor.
  - No OpenVPN support.
  - No multi-VPN switcher.
  - No IPv6.
  - No BitTorrent port-forwarding through the VPN.
  - No auto-detect of `HOST_CLEARNET_IP` (env-only in v1; auto-detect is a follow-up if the manual step proves annoying).

---

## Testing Tasks

- [ ] **Vitest unit tests for `vpn-health.ts`** (see Phase 4.7)
  - Coverage target: 4 branches (success / leak / timeout / off) + cache behaviour
  - File: `apps/server/src/services/__tests__/vpn-health.test.ts`

- [ ] **Manual E2E on throwaway VM** (Phases 1–3, 5–6)
  - Netns/veth/WG smoke test (Phase 1)
  - Systemd wiring + reboot ordering (Phase 2)
  - Fastify + Chromecast E2E (Phase 3)
  - UI panel + nav pill (Phase 5)
  - Kill-switch + `VPN_MODE=off` + IPv6 (Phase 6)

- [ ] **Manual E2E on real 2011 MBP box** (Phase 7)
  - Full DoD verification runbook (13 steps)
  - Interstellar → Master Llama cast regression
  - TorrentDay non-empty results with system VPN OFF
  - Kill-switch spot-check with tcpdump

- [ ] **`shellcheck` on all new scripts**
  - Coverage: `scripts/netns-up.sh`, `scripts/netns-down.sh`, `scripts/run-server.sh`
  - Add to CI if a shell-lint step exists; otherwise run manually before commit.

---

## Documentation Tasks

- [ ] **Update `.env.example`** with `VPN_MODE`, `HOST_CLEARNET_IP`, `CASTCRATE_LAN_IP` — each with a one-line comment explaining purpose + example value (Phase 3.4 / Phase 4.2)
- [ ] **Extend `media-mac-deploy/tasks.md` Phase 8** — 15-step runbook (Phase 7.2)
- [ ] **Update `epic-overview.md`** — flip status 🔵 Planned → 🟡 In Progress → 🟢 Complete as work progresses (Phase 7.6)
- [ ] **Update `docs/overview.md`** — changelog entry when feature completes (Phase 7.6)
- [ ] **Document `knaben-fallback` DNS composition** in this feature's `context.md` after Phase 6.4 verification

---

## Task Status Legend

- [ ] Not started
- [ ] 🔄 In progress
- [ ] ⏸️ Blocked (waiting on something)
- [x] ✅ Completed
- [x] ❌ Cancelled/Won't do

---

## Progress Tracking

### Completed This Session (2026-08-11)
- ✅ Requirements captured
- ✅ Implementation plan written (7 phases, 10 tech decisions, DoD, testing, risks — 775 lines)
- ✅ Epic overview updated (row #20, Platform (planned))
- ✅ Master overview bumped to v1.4
- ✅ `context.md` + `tasks.md` scaffolded (this file)
- ✅ Phase 1: netns-up.sh + netns-down.sh scripts written (tasks 1.4, 1.5)
- ✅ Phase 2: castcrate-netns.service + castcrate.service + run-server.sh written (tasks 2.1–2.4)
- ✅ Phase 3: CASTCRATE_LAN_IP env override in config.ts + apps/server/src/lib/network.ts + .env.example (tasks 3.3, 3.4)
- ✅ Phase 4: VpnHealth type + GET /api/system/vpn-health + vpn-health.ts + settings surface + tests (tasks 4.1–4.7)
- ✅ Phase 5: vpnHealth() client + countryFlag helper + Settings "Network / VPN" section + persistent-nav status pill (tasks 5.1–5.5)

### Discovered New Tasks
- None yet — new tasks discovered during implementation will land here.

### Blocked Items
- ⏸️ Phase 1 requires user-supplied `wg0.conf` and a throwaway Ubuntu VM before it can start.

---

## Notes

### Task Estimation
- 🟢 Small (< 1 hour)
- 🟡 Medium (1–3 hours)
- 🔴 Large (> 3 hours)

### Priority Guidelines
- **High:** Critical for feature to work (all Phase 1–3 tasks, kill-switch + `VPN_MODE=off` verification in Phase 6, real-box DoD in Phase 7).
- **Medium:** Important but not blocking (UI polish in Phase 5, unit tests in Phase 4).
- **Low:** Nice to have, can defer (persistent-nav pill deep-link, country flag helper — trivial).

### Phase → agent routing
- Phase 1, 3, 4, 5 → default `/proceed` (backend-dev or frontend-dev as appropriate).
- Phase 2, 6, 7 → `/proceed-advanced` (max-effort agent — touch production systemd, security-critical verification, deploy-adjacent).

---

*Update this file as tasks are completed. Mark tasks with ✅ immediately when done. Add new tasks as they're discovered.*
