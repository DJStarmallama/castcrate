# vpn-split-tunnel — Implementation Plan

**Epic:** castcrate
**Status:** In Progress
**Started:** 2026-08-11
**Target Completion:** TBD (after `player-buffer-ux` fix pass; independent of TMDB metadata)
**Last Updated:** 2026-08-11 15:07

---

## Executive Summary

Run the CastCrate Fastify server inside a Linux **network namespace** (`castcrate-ns`) whose default route is a WireGuard tunnel. A veth pair with explicit RFC1918 + multicast exception routes preserves LAN + mDNS reachability, and a host-side iptables DNAT rule republishes `:3000` from the LAN interface into the ns. Every existing feature — indexers, torrent engine, subtitle fetch, metadata lookups — becomes transparently VPN-routed with **zero application code change**, while Chromecast discovery and casting continue to work unchanged. The user drops a `wg0.conf` from any commercial provider at `/etc/castcrate/wg0.conf`; CastCrate itself never touches credentials, and `VPN_MODE=off` degrades the netns unit to a no-op for local dev.

---

## Goals

**Primary**
- All external egress from the CastCrate server (indexer HTTP, torrent tracker + DHT, subtitle sources, metadata APIs) exits through the user-supplied WireGuard tunnel.
- LAN reachability preserved: browsers on the same subnet still reach `http://<box>:3000`, and Chromecast mDNS discovery + castv2 control + HTTP stream fetches from the receiver all continue working.
- Fail-closed by design: if the WG peer drops, outbound requests hang or fail rather than leaking to the home IP.
- Zero credential handling in the app or repo.
- Zero application code change in any existing feature (indexers, torrent, transcode, cast, subtitles, metadata).

**Secondary**
- Visible VPN status (mode, exit country, exit IP, leak state) surfaced via `GET /api/system/vpn-health`, a Settings panel, and a persistent nav status pill.
- `VPN_MODE=off` is a first-class no-op for macOS local dev — behaviour byte-identical to today.
- Runbook integration: fold into `media-mac-deploy` as Phase 8 so the deploy story stays single-source-of-truth.
- Reproducible on any Ubuntu Server 26.04 host from the runbook alone.

---

## Architecture Overview

```
                            ┌───────────────────────────────┐
                            │      WireGuard peer           │
                            │   (Mullvad / PIA / Proton…)   │
                            │      wg endpoint UDP :51820   │
                            └──────────────┬────────────────┘
                                           │  encrypted UDP
                                           │
    ─────────────── HOST NETNS (default) ──┼──────────────────────────────────
                                           │
   ┌──────────────┐        ┌──────────────┴──────────────┐
   │ LAN clients  │        │  Host wg-castcrate?  NO —   │
   │ (laptop,     │        │  wg lives INSIDE the ns.    │
   │  Chromecast) │        │  Host sees only eth0.       │
   └──────┬───────┘        └─────────────────────────────┘
          │
          │ TCP :3000
          ▼
   ┌────────────────────────────────────────────────────────┐
   │ eth0 / enp0s… (192.168.x.y)      HOST                 │
   │                                                        │
   │   PREROUTING nat DNAT:                                 │
   │     -i <lan_if> -p tcp --dport 3000                    │
   │     -j DNAT --to 10.200.200.2:3000                     │
   │                                                        │
   │   veth-cc-host  10.200.200.1/30 ─────────────┐        │
   └───────────────────────────────────────────────┼────────┘
                                                   │
                                       veth pair (kernel-side)
                                                   │
   ┌───────────────────────────────────────────────┼────────┐
   │ CASTCRATE-NS                                  │        │
   │                                                        │
   │   veth-cc-ns  10.200.200.2/30 ────────────────┘        │
   │                                                        │
   │   Routing table (order matters):                       │
   │     10.0.0.0/8       via 10.200.200.1 dev veth-cc-ns   │
   │     172.16.0.0/12    via 10.200.200.1 dev veth-cc-ns   │
   │     192.168.0.0/16   via 10.200.200.1 dev veth-cc-ns   │
   │     224.0.0.0/4      via 10.200.200.1 dev veth-cc-ns   │
   │     default          dev wg-castcrate                  │
   │                                                        │
   │   ┌──────────────────────────┐                         │
   │   │ wg-castcrate (WireGuard) │──── all non-LAN egress  │
   │   │ from /etc/castcrate/     │                         │
   │   │ wg0.conf                 │                         │
   │   └──────────────────────────┘                         │
   │                                                        │
   │   ┌──────────────────────────┐                         │
   │   │ Fastify (:3000)          │  listens 0.0.0.0:3000   │
   │   │  - indexers ──► WG                                 │
   │   │  - torrent  ──► WG (trackers, DHT, peers)          │
   │   │  - subtitles ──► WG                                │
   │   │  - metadata  ──► WG                                │
   │   │  - LAN reply ──► veth (LAN clients + Chromecast)   │
   │   │  - mDNS      ──► veth (224.0.0.251:5353/udp)       │
   │   └──────────────────────────┘                         │
   └────────────────────────────────────────────────────────┘

Traffic flows:
  1. LAN → box:3000     : eth0 → DNAT → veth pair → Fastify (unchanged UX)
  2. Fastify → indexer  : default route → wg-castcrate → tunnel → clearnet
  3. Fastify → Chromecast IP (192.168.x.z:8009) : RFC1918 exception → veth → host → LAN
  4. Fastify mDNS query : multicast exception → veth → host → LAN 224.0.0.251
  5. WG peer drop       : default route dead → connect() hangs / ECONNREFUSED (fail-closed)
```

**Key invariants:**
- `wg-castcrate` lives *inside* the ns, not on the host. Host retains its clearnet default route on `eth0` — user's SSH sessions and unrelated processes are unaffected.
- The four exception routes (`10/8`, `172.16/12`, `192.168/16`, `224.0.0.0/4`) are **more specific** than `default`, so kernel routing always prefers them for LAN + multicast destinations. Everything else takes the `default` via `wg-castcrate`.
- No IP forwarding on the host is required for the LAN → ns path (DNAT rewrites the destination; reply follows the same path back). No `sysctl net.ipv4.ip_forward` toggle.
- IPv6 is explicitly disabled inside the ns (`sysctl -w net.ipv6.conf.all.disable_ipv6=1` in `netns-up.sh`) — no v6 default route, no v6 leak surface.

---

## Implementation Phases

Effort key: **S** ≤ 2h, **M** ≤ 1 day, **L** > 1 day.
Phases marked **[max-effort]** should be routed to an advanced dev agent by `/proceed` — they touch production units, security-critical paths, or require packet-capture verification.

### Phase 1 — Namespace scaffolding on a throwaway Ubuntu VM

**Goal:** Prove the netns + WG + veth + exception routes work in isolation, on a disposable Ubuntu 26.04 VM. No CastCrate code involved. This phase de-risks every downstream phase; if the routing model is wrong we find out here without touching the deployed box.

**Effort:** M

**Tasks**
- [ ] Spin up an Ubuntu 26.04 VM (Multipass, UTM, or a spare box). `apt install wireguard-tools iproute2 iptables-nft`.
- [ ] Drop a real `wg0.conf` from the user's provider at `/etc/castcrate/wg0.conf` (mode 600, root:root).
- [ ] Write `scripts/netns-up.sh`:
  - `set -euo pipefail`; every step `echo`'d with a `[netns-up]` prefix.
  - Idempotent guards: `ip netns list | grep -q castcrate-ns || ip netns add castcrate-ns`.
  - Create veth pair: `veth-cc-host` ↔ `veth-cc-ns`; move `veth-cc-ns` into `castcrate-ns`.
  - Assign `10.200.200.1/30` on host side, `10.200.200.2/30` on ns side. Bring both `up`.
  - Inside ns: `sysctl -w net.ipv6.conf.all.disable_ipv6=1`, `net.ipv6.conf.default.disable_ipv6=1`, `net.ipv6.conf.lo.disable_ipv6=1`. `ip link set lo up`.
  - Bring up `wg-castcrate` inside the ns using `wg-quick`-equivalent primitives (see Phase 2 note on `wg-quick` vs manual `wg setconf` — this phase uses manual to stay explicit).
  - Add the four exception routes inside the ns (`10/8`, `172.16/12`, `192.168/16`, `224.0.0.0/4` via `10.200.200.1`).
  - Add the DNAT rule on the host: `iptables -t nat -A PREROUTING -i <lan_if> -p tcp --dport 3000 -j DNAT --to-destination 10.200.200.2:3000`. Detect `<lan_if>` from `ip route show default | awk '/default/ {print $5; exit}'`.
- [ ] Write `scripts/netns-down.sh` — reverse order, each step guarded by "if exists". `-D` the DNAT rule, `ip link del veth-cc-host` (deletes both ends), `ip netns del castcrate-ns`. No error if any piece is already gone.
- [ ] Verify inside ns: `ip netns exec castcrate-ns curl -s https://ifconfig.co/json` returns the **VPN exit IP** (not the VM's public IP).
- [ ] Verify on host: `curl -s https://ifconfig.co/json` returns the **VM's clearnet IP**.
- [ ] Verify LAN reachability: from another machine on the LAN, `curl http://<vm-ip>:3000` reaches a test listener you start inside the ns (`ip netns exec castcrate-ns python3 -m http.server 3000`).
- [ ] Idempotency: run `netns-up.sh` twice in a row — no error, no duplicate routes.
- [ ] Teardown: `netns-down.sh` cleanly removes everything; `netns-down.sh` a second time also succeeds.

**Files touched (new)**
- `scripts/netns-up.sh`
- `scripts/netns-down.sh`

**Acceptance criteria**
- Inside-ns curl returns VPN IP; host curl returns clearnet IP; both from the *same VM*.
- LAN peer reaches `http://<vm-ip>:3000` and gets the Python test listener response.
- Both scripts pass `shellcheck`. Both are safe to run twice in either order.
- No `sysctl net.ipv4.ip_forward=1` toggle required (verify by running without it — the DNAT-in-PREROUTING path does not need it because the reply reuses conntrack state on the same host).

---

### Phase 2 — systemd wiring **[max-effort]**

**Goal:** Wrap Phase 1's scripts as a systemd oneshot that CastCrate depends on, and rewrite `castcrate.service` to `exec` Fastify inside the ns. Get the ordering, sandbox flags, and teardown right on the same VM.

**Effort:** M

Why max-effort: this is the exact surface where the `media-mac-deploy` tilde-footgun and silent-swallow bugs surfaced last time. `ProtectSystem=`, `ProtectHome=`, `ReadWritePaths=`, and `ip netns exec` interact non-obviously. Absolute paths only; no tildes anywhere. Also touches the production unit — a broken change here bricks the deploy.

**Tasks**
- [ ] Create `deploy/systemd/castcrate-netns.service`:
  ```
  [Unit]
  Description=CastCrate network namespace (VPN split-tunnel)
  After=network-online.target
  Wants=network-online.target
  ConditionPathExists=/etc/castcrate/wg0.conf

  [Service]
  Type=oneshot
  RemainAfterExit=yes
  ExecStart=/opt/castcrate/scripts/netns-up.sh
  ExecStop=/opt/castcrate/scripts/netns-down.sh
  # No sandbox flags on this unit — it needs CAP_NET_ADMIN + iptables + ip netns.
  # Runs as root by necessity.

  [Install]
  WantedBy=multi-user.target
  ```
  Note the `ConditionPathExists` — if `wg0.conf` is missing, the unit becomes a no-op and the dependent `castcrate.service` proceeds without it (see Phase 6 for the `VPN_MODE=off` path).
- [ ] Write `scripts/run-server.sh` (wrapper trampoline):
  ```
  #!/usr/bin/env bash
  set -euo pipefail
  # Absolute paths only — no tildes. Env vars are already resolved by systemd
  # (via EnvironmentFile=) at unit-start time; we just exec.
  exec /usr/bin/node /opt/castcrate/apps/server/dist/index.js
  ```
  Rationale: `ip netns exec` + a systemd `ExecStart=` line that also does redirection / substitution is fragile; a small shell trampoline resolves cleanly. Mirrors the working pattern from `media-mac-deploy` Phase 6.
- [ ] Update `deploy/systemd/castcrate.service`:
  - Add `After=castcrate-netns.service` and `Requires=castcrate-netns.service` (or `Wants=` when `VPN_MODE=off` — see Phase 6).
  - Change `ExecStart=` to `/usr/sbin/ip netns exec castcrate-ns /opt/castcrate/scripts/run-server.sh`.
  - Keep existing sandbox flags: `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=/home/castcrate/castcrate-downloads`.
  - **Do not** re-scope `ReadWritePaths` with tildes — copy the absolute path already in use.
  - Consider adding `StateDirectory=castcrate` if Phase 4 needs writable state for VPN health caching (systemd creates `/var/lib/castcrate` at 0700 owned by the service user). Decision: add it now — cheap, and the health endpoint may want to persist the boot-time clearnet-IP fingerprint.
- [ ] Verify ordering on the VM:
  - `systemctl start castcrate.service` → observe `castcrate-netns.service` starts first, then Fastify.
  - `systemctl stop castcrate.service` → Fastify stops; `castcrate-netns.service` remains (per `RemainAfterExit=yes`). Then `systemctl stop castcrate-netns.service` tears down the ns.
  - Reboot the VM — both units come up in the right order; `curl http://<vm-ip>:3000/api/ping` returns 200 within 30s of the login prompt.
- [ ] Verify sandbox interaction: `journalctl -u castcrate` shows no `access denied` / `read-only file system` errors on startup or shutdown.

**Files touched**
- `deploy/systemd/castcrate-netns.service` (new)
- `deploy/systemd/castcrate.service` (edit)
- `scripts/run-server.sh` (new)

**Acceptance criteria**
- Cold boot on the VM: `systemctl is-active castcrate castcrate-netns` both return `active`.
- `journalctl -u castcrate --since "10 min ago" | grep -iE "error|denied|failed"` returns nothing alarming.
- Stopping and restarting `castcrate.service` does not tear down the ns (RemainAfterExit works as intended).
- Stopping `castcrate-netns.service` cleanly removes the ns, veth, and DNAT rule; a second stop is a no-op.

---

### Phase 3 — Fastify inside the namespace **[max-effort]**

**Goal:** Run the actual CastCrate server inside the ns on the throwaway VM and prove the LAN-facing surface works end-to-end: browser can load the UI, Chromecast is discovered, cast + play succeeds.

**Effort:** M

Why max-effort: this is the integration point most likely to hit hidden regressions — Chromecast discovery uses mDNS multicast, inbound TCP from the receiver back to `:3000` for the stream, and the server's own `os.networkInterfaces()` LAN-IP detection. Each of those has to keep working inside the ns.

**Tasks**
- [ ] `git clone` CastCrate onto the VM; `pnpm install`, build. Copy `.env.example` → `apps/server/.env`; set `OMDB_API_KEY`, `PORT=3000`, `DOWNLOAD_PATH=…`.
- [ ] Start the server via the systemd path from Phase 2 (not manually) — ensures we test the real config.
- [ ] Verify LAN UI: from a laptop on the same LAN, `http://<vm-ip>:3000` loads the UI. Search for a movie — OMDb results appear (proves outbound HTTP through WG works).
- [ ] Verify LAN-IP detection: hit `/api/system/check` and confirm the reported `lanIp` is the veth-ns address (`10.200.200.2`) or the DNAT-published LAN IP (`192.168.x.y`) — whichever the existing `getLanIp()` helper returns *inside* the ns. If it picks the veth address, the Chromecast stream URL construction (`http://<lanIp>:3000/stream/...`) will point at an unreachable-from-LAN address.
  - **Expected finding:** `os.networkInterfaces()` inside the ns only sees `lo` and `veth-cc-ns`, so `getLanIp()` will return `10.200.200.2` (or nothing). This will break `routes/cast.ts` URL construction for the receiver.
  - **Fix:** introduce an env override `CASTCRATE_LAN_IP=192.168.x.y` read by `getLanIp()` — set it in the systemd `EnvironmentFile`. Falls through to auto-detect when unset (macOS dev). Document in `.env.example`.
  - Verify: `getLanIp()` returns the value of `CASTCRATE_LAN_IP` when set; auto-detects otherwise. Existing dev flow unchanged.
- [ ] Verify Chromecast discovery: `bonjour-service` in `services/cast.ts` runs inside the ns; the multicast exception route (`224.0.0.0/4` via veth) must let mDNS queries out and responses in. Hit `/api/cast/devices` — the target Chromecast appears in the list.
- [ ] Verify end-to-end cast: `/api/cast/play` with a real title. Chromecast fetches the stream from `http://<CASTCRATE_LAN_IP>:3000/stream/...` (via the DNAT rule); playback starts on the TV.
- [ ] Verify subtitle track fetch from Chromecast: play a title with a subtitle track; confirm Chromecast fetches `/stream/:hash/subtitles/:idx` successfully (same DNAT path).
- [ ] If mDNS fails: verify with `tcpdump -i veth-cc-host udp port 5353` on the host that queries are leaving the ns; `tcpdump -i <lan_if> udp port 5353` on the host that they reach the LAN. Fix routing / iptables as needed and document.

**Files touched**
- `apps/server/src/lib/cast-lan.ts` (or wherever `getLanIp()` lives) — add `CASTCRATE_LAN_IP` env override. **Note:** verify the exact path during implementation; the exec-path pattern from existing routes (`getLanIp` referenced from `routes/cast.ts`) should point you at it.
- `apps/server/src/lib/config.ts` — read `CASTCRATE_LAN_IP`.
- `.env.example` — document `CASTCRATE_LAN_IP`.

**Acceptance criteria**
- LAN browser loads the UI at `http://<vm-ip>:3000`.
- `/api/cast/devices` lists the LAN Chromecast.
- End-to-end cast of a real title starts playback on the TV; server logs no fetch errors from the receiver.
- With `CASTCRATE_LAN_IP` unset on macOS dev, `getLanIp()` still auto-detects correctly (regression check).
- `/api/system/check` shows the effective `lanIp` matching `CASTCRATE_LAN_IP`.

---

### Phase 4 — `GET /api/system/vpn-health` endpoint + `VpnHealth` shared type

**Goal:** Give the UI, runbook, and future monitoring a single canonical source of truth for VPN status.

**Effort:** S

Alignment: uses the existing `/api/system/*` convention already established by `/api/system/check` — not a top-level `/health/vpn`.

**Tasks**
- [ ] Add to `packages/shared/src/index.ts`:
  ```ts
  export type VpnMode = "vpn" | "off" | "unknown";

  export interface VpnHealth {
    /** "off" when VPN_MODE=off or no wg0.conf present; "vpn" when the ns is up
     *  and wg-castcrate is present; "unknown" while the first probe is in flight. */
    mode: VpnMode;
    /** Public IP observed from inside the ns (via ifconfig.co / ipinfo.io).
     *  null while the probe is pending or has failed. */
    publicIp: string | null;
    /** ISO 3166-1 alpha-2 country code from the lookup. null if unknown. */
    country: string | null;
    /** WG peer endpoint host:port from `wg show` — informational only. */
    wgPeer: string | null;
    /** True if the last outbound probe succeeded within the timeout. */
    reachable: boolean;
    /** True if publicIp matches the host's clearnet IP fingerprint captured at
     *  boot — i.e. the tunnel is not actually rewriting egress. Always false
     *  when mode === "off". */
    leaking: boolean;
    /** Unix ms of the last successful probe. null if never succeeded. */
    lastCheckedAt: number | null;
  }
  ```
- [ ] Add `apps/server/src/routes/system.ts` (or extend if it exists — currently `/api/system/check` lives there):
  - `GET /api/system/vpn-health` → returns cached `VpnHealth` (see caching below).
  - Reads `VPN_MODE` env: if `off`, return `{ mode: "off", ... , leaking: false, reachable: true }` immediately (no probe).
  - Otherwise: probe `https://ifconfig.co/json` with 3s timeout; parse `{ ip, country_iso }`; compare `ip` against the host's boot-time clearnet fingerprint (see next task) to compute `leaking`.
  - Cache the last successful result in-memory (and optionally to `/var/lib/castcrate/vpn-last.json` via the `StateDirectory=castcrate` from Phase 2) for 30s to avoid hammering the lookup service.
  - Include `?refresh=1` query param to force a fresh probe.
- [ ] Add `apps/server/src/services/vpn-fingerprint.ts`:
  - On server boot, run a **one-shot subprocess** `curl -s --max-time 3 https://ifconfig.co/ip` **from the host netns** (i.e. *not* through the ns) using a helper script (see below) to capture the clearnet IP. Store in memory.
  - The helper script `scripts/host-public-ip.sh` runs `curl` bound to the host's default route so it's reliable regardless of whether Fastify itself is running inside the ns. Called via `spawn` at boot.
  - **Alternative if the host-side subprocess is fiddly:** allow the user to set `HOST_CLEARNET_IP` explicitly in env; skip the boot probe when set. Document both in `.env.example`. YAGNI: implement env-only first, add the subprocess auto-detect only if the DoD calls for it.
  - Decision: **env-only in v1.** The runbook (Phase 7) instructs the user to `curl ifconfig.co/ip` *before* enabling the netns and paste the result into `HOST_CLEARNET_IP=`. Simple, deterministic, no subprocess-in-systemd-sandbox surface.
- [ ] Add WG peer inspection: `wg show wg-castcrate endpoints` returns the peer host:port. Since the ns view of `wg-castcrate` is only visible to processes inside the ns, and Fastify runs inside the ns, this is a plain `wg show` invocation from the server. Parse the first non-empty line.
- [ ] Register the route in the server bootstrap (wherever `/api/system/check` is currently registered).
- [ ] Unit test the handler with a mocked `undici` request to `ifconfig.co` — cover success (vpn IP != host IP → `leaking: false`), leak (vpn IP == host IP → `leaking: true`), timeout (→ `reachable: false`), and `VPN_MODE=off` (→ short-circuit without probing).

**Files touched**
- `packages/shared/src/index.ts` (add `VpnHealth`, `VpnMode`)
- `apps/server/src/routes/system.ts` (add `/api/system/vpn-health`)
- `apps/server/src/services/vpn-health.ts` (new — probe + cache + `wg show` parse)
- `apps/server/src/services/settings.ts` (surface `vpnMode` on GET response — read-only, presence-only for the peer endpoint to avoid leaking exit country in the API response body)
- `apps/server/src/lib/config.ts` (add `VPN_MODE`, `HOST_CLEARNET_IP`)
- `.env.example` (document both)
- `apps/server/src/services/__tests__/vpn-health.test.ts` (new — mocked fetch)

**Acceptance criteria**
- `GET /api/system/vpn-health` returns a `VpnHealth`-shaped JSON body.
- With `VPN_MODE=vpn` and tunnel up on the VM: `{ mode: "vpn", publicIp: "<VPN IP>", country: "<XX>", leaking: false, reachable: true }`.
- With `VPN_MODE=off`: `{ mode: "off", publicIp: null, country: null, leaking: false, reachable: true }` immediately, no probe network call issued (verify via `tcpdump`).
- Vitest suite passes with 4 cases (success, leak, timeout, off).
- Response is served from cache on rapid repeat calls; `?refresh=1` forces a fresh probe.
- Settings GET response includes `vpnMode` and a boolean `vpnConfigured` (does `/etc/castcrate/wg0.conf` exist?). Never returns the peer public key.

---

### Phase 5 — Settings UI panel + persistent-nav status pill

**Goal:** Make VPN state visible on every screen, and provide a Settings section with the full detail + refresh.

**Effort:** S–M

**Tasks**
- [ ] Add `apps/web/src/lib/api.ts` client function `vpnHealth(refresh?: boolean): Promise<VpnHealth>`.
- [ ] Add a "Network / VPN" section to `apps/web/src/components/Settings.tsx`, positioned above the Indexers section:
  - Mode badge: green "VPN" pill when `mode === "vpn" && !leaking`; red "LEAKING" pill when `leaking`; grey "OFF" pill when `mode === "off"`; amber "UNREACHABLE" pill when `!reachable`.
  - Exit IP + country + flag emoji (country code → flag via a small lookup helper; degrade to code alone if country is null).
  - WG peer host:port (informational).
  - Last checked timestamp (relative — "3s ago").
  - "Refresh" button → `vpnHealth(true)`.
  - When `mode === "off"`, show a one-line explainer: "VPN routing disabled. Set `VPN_MODE=vpn` and provide `/etc/castcrate/wg0.conf` to enable."
- [ ] Add a persistent status pill to the top nav (locate the component during implementation — `TopNav.tsx` or the equivalent):
  - Small dot + short label: `VPN · XX` (green), `LEAK` (red, blinks), `OFF` (grey), `?` (amber, unreachable).
  - Fetches `vpnHealth()` on mount and every 60s. Uses React Query if the app already has it (check `package.json`); otherwise a small `useEffect` + `setInterval` is fine.
  - Clicking the pill deep-links to the VPN section in Settings.
- [ ] Tailwind styling only — match existing pill styles in the app for consistency.
- [ ] No new tests — the UI is trivial; the endpoint is unit-tested in Phase 4.

**Files touched**
- `apps/web/src/lib/api.ts` (add `vpnHealth`)
- `apps/web/src/components/Settings.tsx` (add Network / VPN section)
- `apps/web/src/components/TopNav.tsx` (or equivalent — persistent nav pill)
- Possibly a new `apps/web/src/lib/countryFlag.ts` helper (tiny — 3-line ISO code → emoji function).

**Acceptance criteria**
- Settings shows the VPN panel with the correct mode badge and details from `/api/system/vpn-health`.
- Nav pill visible on every route (Discovery, Library, Player, Settings). Colour matches state.
- Refresh button hits `/api/system/vpn-health?refresh=1` and updates within a second.
- With `VPN_MODE=off`, the panel shows the "OFF" state and the explainer — no error, no leaked-state red.
- Toggling the WG peer down (`wg-quick down` inside the ns) on the VM causes the pill to flip to "UNREACHABLE" within 60s of the next poll (or immediately after clicking Refresh).

---

### Phase 6 — Fail-closed kill-switch test + `VPN_MODE=off` no-op path **[max-effort]**

**Goal:** Prove the security-critical claims: (a) if the WG peer drops, no packet leaks to clearnet, and (b) `VPN_MODE=off` is byte-identical to the pre-feature behaviour.

**Effort:** M

Why max-effort: security-critical, requires packet-capture verification, needs the `knaben-fallback` DNS monkey-patch interaction sanity-checked explicitly.

**Tasks**
- [ ] Wire `VPN_MODE=off` handling:
  - `castcrate-netns.service` already has `ConditionPathExists=/etc/castcrate/wg0.conf` (Phase 2), which makes it a no-op when the config is absent.
  - Additionally: in `castcrate.service`, gate the `ip netns exec` prefix via a wrapper script that inspects `VPN_MODE`:
    ```
    #!/usr/bin/env bash
    # /opt/castcrate/scripts/run-server.sh
    set -euo pipefail
    if [ "${VPN_MODE:-off}" = "vpn" ]; then
      exec /usr/sbin/ip netns exec castcrate-ns /usr/bin/node /opt/castcrate/apps/server/dist/index.js
    else
      exec /usr/bin/node /opt/castcrate/apps/server/dist/index.js
    fi
    ```
    This subsumes the trampoline from Phase 2 — merge the two scripts. `castcrate.service`'s `ExecStart=` becomes `/opt/castcrate/scripts/run-server.sh` (no `ip netns exec` prefix in the unit itself).
  - `castcrate.service` uses `Wants=castcrate-netns.service` (not `Requires=`) so an unreachable netns unit doesn't hard-fail Fastify when the user is deliberately in `VPN_MODE=off`.
- [ ] Kill-switch test (on the VM):
  - Start Fastify with `VPN_MODE=vpn`. Verify `/api/system/vpn-health` shows the VPN IP.
  - Start a long-running `tcpdump -n -i <lan_if> 'not port 22 and not port 3000 and not (udp port 5353) and not (udp port 51820)'` on the host (filters out SSH, LAN UI traffic, mDNS, and legitimate WG traffic — anything left over is a leak).
  - `ip netns exec castcrate-ns wg-quick down wg-castcrate` (or manually `ip link set wg-castcrate down`).
  - Trigger an indexer search from the UI (`/api/search/torrents?...` — hits TorrentDay + Knaben + others).
  - Confirm: (a) the search either hangs or returns an error within ~30s, (b) `tcpdump` shows **zero** packets to the indexer's IP on the host `<lan_if>`, (c) `/api/system/vpn-health` reports `{ reachable: false }`.
  - Bring WG back up (`wg-quick up`); confirm the search recovers on the next attempt and `vpn-health` reports `reachable: true`.
- [ ] `knaben-fallback` DNS-monkey-patch interaction:
  - `knaben-fallback` monkey-patches `dns.lookup` process-wide to 1.1.1.1 / 1.0.0.1 (Cloudflare).
  - Inside the ns with the default route via WG, a DNS query to 1.1.1.1 exits *through the tunnel* — the WG peer forwards it to Cloudflare. That's the correct behaviour (no leak, no bypass).
  - Explicit test: `ip netns exec castcrate-ns dig @1.1.1.1 knaben.eu +short` returns an A record. `tcpdump -i <lan_if>` on the host shows zero UDP traffic to `1.1.1.1:53` — the query left via the WG UDP tunnel instead.
  - Document the finding in this plan: **`knaben-fallback` DNS bypass and this feature compose correctly.** No code change required in either.
- [ ] `VPN_MODE=off` regression:
  - Set `VPN_MODE=off` in `.env`; `systemctl restart castcrate`.
  - Verify `castcrate-netns.service` is `inactive` (not `failed`).
  - Verify Fastify is listening on `0.0.0.0:3000` on the host directly (not inside the ns): `ss -tlnp | grep :3000` shows the node process bound to the host.
  - Verify LAN UI still works.
  - Verify `/api/system/vpn-health` returns `{ mode: "off", ... }` immediately (no probe).
  - Verify existing feature behaviour (search, cast) is byte-identical to today — same OMDb results, same TorrentDay behaviour (empty without user's system VPN), same Chromecast flow. This proves the feature is truly opt-in and does not regress the macOS local-dev path.
- [ ] IPv6 leak check: `ip netns exec castcrate-ns ip -6 addr` shows no v6 addresses; `curl -6 https://ifconfig.co/ip` inside the ns fails cleanly (v6 disabled per `netns-up.sh`).

**Files touched**
- `scripts/run-server.sh` (merged trampoline + mode-gate — supersedes the Phase 2 version)
- `deploy/systemd/castcrate.service` (change `Requires=` → `Wants=` for netns dep, `ExecStart=` → `run-server.sh` without `ip netns exec` prefix)
- No test file additions — the tests are runbook steps executed manually with `tcpdump`.

**Acceptance criteria**
- Kill-switch test: WG down → tcpdump on `<lan_if>` shows zero packets to indexer IPs during a search; `/api/system/vpn-health` reports `{ reachable: false }`.
- WG up again → recovery within one search-retry cycle; `vpn-health` reports `reachable: true`.
- `knaben-fallback` DNS: `dig @1.1.1.1` inside the ns succeeds; host `tcpdump` shows zero UDP to `1.1.1.1:53` on `<lan_if>` (confirms it left via the tunnel).
- `VPN_MODE=off`: `castcrate-netns` inactive; Fastify bound to host; behaviour matches pre-feature baseline; `vpn-health` returns `{ mode: "off" }` with no network call.
- No IPv6 addresses inside the ns; v6 curl fails cleanly.

---

### Phase 7 — Runbook: `media-mac-deploy` Phase 8 + real-box execution **[max-effort]**

**Goal:** Fold the deploy story into the existing runbook so future re-installs pick it up. Then execute it on the actual 2011 MBP box to close the feature.

**Effort:** M

Why max-effort: deploy-adjacent, non-reversible if we typo an iptables rule and lock ourselves out over SSH. Also the tilde-footgun and sandbox-interaction gotchas from `media-mac-deploy` apply verbatim.

**Tasks**
- [ ] Add "Phase 8: VPN split-tunnel" to `docs/features/castcrate/media-mac-deploy/tasks.md`. Structure it like the existing phases (checkboxes, ~20-min estimate, verification steps):
  1. `sudo apt install -y wireguard-tools iptables-nft` (add to Phase 3's apt install list too, to future-proof clean installs).
  2. `sudo mkdir -p /etc/castcrate; sudo chmod 700 /etc/castcrate`.
  3. Download `wg0.conf` from provider dashboard (Mullvad account page / PIA WG generator / ProtonVPN downloads / AirVPN config generator). Copy to `/etc/castcrate/wg0.conf`; `sudo chmod 600 /etc/castcrate/wg0.conf; sudo chown root:root /etc/castcrate/wg0.conf`.
  4. Capture the box's clearnet IP *before* enabling the ns: `curl -s https://ifconfig.co/ip`. Add `HOST_CLEARNET_IP=<value>` to `apps/server/.env`. Set `VPN_MODE=vpn`.
  5. Copy `scripts/netns-up.sh`, `scripts/netns-down.sh`, `scripts/run-server.sh` to `/opt/castcrate/scripts/`; `sudo chmod +x`.
  6. Copy `deploy/systemd/castcrate-netns.service` to `/etc/systemd/system/`.
  7. Update `deploy/systemd/castcrate.service` per Phase 6; copy to `/etc/systemd/system/`.
  8. `sudo systemctl daemon-reload; sudo systemctl enable --now castcrate-netns.service`.
  9. `sudo systemctl restart castcrate.service`.
  10. Verify: `ip netns exec castcrate-ns curl -s https://ifconfig.co/json` shows the VPN exit IP.
  11. Verify: `curl -s http://localhost:3000/api/system/vpn-health` returns `{ mode: "vpn", leaking: false, reachable: true, ... }`.
  12. From a LAN laptop: `http://<box>:3000` loads; nav pill shows green `VPN · XX`.
  13. Cast regression: search **Interstellar**, cast to **Master Llama** (the exact title from the `media-mac-deploy` closing test), confirm playback.
  14. TorrentDay regression: search a title known to have TD results, confirm non-empty results with no manual system VPN toggling.
  15. Kill-switch spot-check: `sudo ip netns exec castcrate-ns wg-quick down wg-castcrate`, trigger a search from the UI, confirm it fails cleanly (nav pill flips to UNREACHABLE within 60s). Bring WG back up.
- [ ] Document the `VPN_MODE=off` fallback in the runbook: if the user later removes `/etc/castcrate/wg0.conf` or sets `VPN_MODE=off`, `systemctl restart castcrate` reverts to pre-feature behaviour.
- [ ] Execute the runbook on the real 2011 MBP over SSH. Log any deviations back into the runbook doc as amendments (the runbook is the durable artefact; this plan is one-shot).
- [ ] **Post-execution:** hit `/api/system/vpn-health` from the LAN, cast Interstellar, verify TorrentDay returns results. If any step fails, don't paper over it — fix the underlying script/unit and re-verify.

**Files touched**
- `docs/features/castcrate/media-mac-deploy/tasks.md` (add Phase 8; extend Phase 3 apt list)
- On the deployed box: `/etc/castcrate/wg0.conf`, `/opt/castcrate/scripts/*.sh`, `/etc/systemd/system/castcrate*.service`, `/home/castcrate/castcrate/apps/server/.env` — all outside the repo.
- Amendments to this `implementation.md` if the real box surfaces something the VM didn't.

**Acceptance criteria (executed on the deployed box)**
- All 15 runbook steps checked off.
- `GET /api/system/vpn-health` from a LAN client returns `{ mode: "vpn", publicIp: <VPN IP>, country: "<XX>", leaking: false, reachable: true }`.
- Full end-to-end cast of Interstellar → Master Llama succeeds.
- TorrentDay search returns non-empty results, with the box's *system-level* VPN OFF (proves the netns split is doing the work).
- Kill-switch verified live: WG down → search fails, no leak visible in `tcpdump`. WG back up → recovery.
- Reboot the box; both units come back cleanly; the cast test still works.

---

## Key Technical Decisions

### 1. Whole-server-in-ns vs per-source app-level routing

**Decision:** Run the entire Fastify server inside a Linux network namespace with WG as default route.

**Alternatives considered:**
- **Per-source `useVpn` flag + undici Agent switching.** Add a config toggle per indexer; route TorrentDay through a SOCKS5 proxy over WG, leave YTS on clearnet. **Rejected:** N adapters × M outbound paths (torrent trackers, DHT, subtitle fetches, metadata calls) = a combinatorial matrix of fragile plumbing. Every new feature has to remember to opt in. Torrent DHT + peer connections use `net.Socket` directly and can't easily be intercepted by an `undici.Agent`.
- **Mullvad-style per-app split at the desktop-app layer.** **Rejected:** requires the Mullvad app, GUI-only, and vendor lock-in. We want any provider.

**Rationale:** OS-layer routing means every existing feature is transparently VPN-routed with zero application code change. Torrent DHT, tracker HTTPS, WebTorrent peer TCP/UDP, subtitle HTTP, OMDb, Stremio addons, Knaben — all inherit the ns default route with no code awareness of the tunnel. New features get the property for free. Cost: some Linux-specific ops complexity, which is fine because the deploy is Ubuntu-only anyway.

### 2. WireGuard only in v1

**Decision:** WG only. No OpenVPN support.

**Alternatives:** OpenVPN (both TCP and UDP modes).

**Rationale:** Every serious commercial provider ships WG configs now (Mullvad, PIA, Proton, AirVPN, IVPN, all the small ones). WG is a single UDP flow, kernel-integrated, and `wg-quick` is ~30 lines of setup vs OpenVPN's `openvpn`-in-a-namespace dance. If a specific provider ever requires OpenVPN, add it as a follow-up feature; do not pre-build it.

### 3. User-provided `wg0.conf`

**Decision:** User drops a config from their provider at `/etc/castcrate/wg0.conf`. CastCrate ships no credentials, no config generator, no provider API integrations.

**Alternatives considered:**
- **In-app WG config UI editor.** **Rejected:** doubles the credential-handling surface (parsing + validation + storage + masking), and every provider has slight schema differences.
- **Provider API integration** (log into Mullvad, generate keys via their REST API). **Rejected:** vendor lock, credential storage in the app.

**Rationale:** Matches the existing pattern of user-supplied `OMDB_API_KEY`, TorrentDay cookies, Stremio addon URLs — CastCrate is the runtime, the user brings the credentials. Zero surface for us to leak. Provider-agnostic: any WG-shipping VPN works, including self-hosted WG endpoints (paranoid users).

### 4. RFC1918 + multicast exception routes vs Mullvad-style per-app split

**Decision:** Four explicit routes inside the ns: `10/8`, `172.16/12`, `192.168/16` (RFC1918) and `224.0.0.0/4` (multicast) via the veth to the host. Everything else via `default` on `wg-castcrate`.

**Alternatives:** cgroups + `iptables -m cgroup` per-app matching; policy routing with `ip rule`.

**Rationale:** Longest-prefix-match routing does the split for free — no iptables MARK dance, no cgroup awareness required. The exception routes are more specific than `default`, so LAN + multicast destinations always take the veth; everything else takes WG. Reasoning is one `ip route` command and readable in the netns.

### 5. Fail-closed kill switch is intrinsic (not opt-in)

**Decision:** No fallback route to clearnet if WG drops.

**Alternatives:** clearnet fallback with a UI warning.

**Rationale:** The whole point of this feature is that some sources need VPN routing. Leaking to clearnet defeats the purpose and — for TorrentDay in particular — is exactly the scenario the user wanted to prevent. Fail-closed is free with this design because the default route points at a dead interface; connect() calls hang or return ECONNREFUSED. UI surfaces the state via the LEAKING / UNREACHABLE pill so the user notices immediately.

### 6. `/api/system/vpn-health` naming

**Decision:** Nest under `/api/system/*` alongside the existing `/api/system/check`, not at top-level `/health/vpn`.

**Rationale:** Aligns with the existing convention. The requirements doc originally spec'd `/health/vpn` but the codebase pattern is `/api/system/*` for read-only status endpoints. Following the pattern reduces client-side special-casing and matches what a future engineer would expect.

### 7. `VPN_MODE=off` as a first-class no-op

**Decision:** `VPN_MODE=off` (or absence of `/etc/castcrate/wg0.conf`) makes `castrcrate-netns.service` a no-op via `ConditionPathExists=`, and the `run-server.sh` wrapper runs Fastify on the host directly. Behaviour byte-identical to the pre-feature baseline.

**Alternatives:** always require the ns to be up; fail startup if `wg0.conf` is missing.

**Rationale:** macOS local dev must keep working (no netns on Darwin), and some users may not want VPN routing at all. Making it a hack ("just don't enable the unit") creates two subtly different runtime environments and drift. Making it a first-class mode means the exact same systemd unit files ship in both configurations.

### 8. iptables NAT DNAT vs socat / userspace proxy

**Decision:** Single-line iptables DNAT in the host's `nat/PREROUTING` chain rewriting `<lan_if>:3000 → 10.200.200.2:3000`.

**Alternatives:** `socat` listener on host `:3000` forwarding into the ns; user-space port forwarder.

**Rationale:** DNAT is one rule, in-kernel, zero extra process. `socat` would need its own systemd unit, buffer copies through userspace, and be another failure mode. The DNAT rule cleans up naturally in `netns-down.sh` (matching `-D`).

### 9. Coexistence with the planned `proxy-routing` feature

**Decision:** VPN split-tunnel and per-provider SOCKS/HTTP proxies compose cleanly. VPN routes *all* egress by default; `proxy-routing` layers a per-source SOCKS5/HTTP redirect on top for cases where a specific source needs a specific exit country or a paid residential proxy.

**Rationale:** They operate at different layers (OS routing vs application-layer dispatcher). A `proxy-routing` HTTP request inside the ns first hits the SOCKS5 proxy address; the connection to that proxy is itself carried by the WG tunnel (unless the proxy is on RFC1918, in which case it takes the LAN exception route). No conflict. Documented so future maintainers don't try to "simplify" by removing one when the other lands.

### 10. No IPv6 in v1

**Decision:** IPv6 explicitly disabled inside the ns via `sysctl net.ipv6.conf.all.disable_ipv6=1`.

**Alternatives:** run WG dual-stack; add `::/0` default via WG.

**Rationale:** Dual-stack multiplies the leak surface (v6 default route bypasses v4 WG if misconfigured). No v6-only sources in the feature roster. The user's home network may or may not have working v6 anyway. YAGNI: add v6 the day we have a v6-only requirement.

---

## Definition of Done

### Functional

- [ ] On the deployed 2011 MBP box with `/etc/castcrate/wg0.conf` present and `castcrate-netns.service` enabled:
  - `ip netns exec castcrate-ns curl -s https://ifconfig.co/json` returns the **VPN exit IP**.
  - `curl -s https://ifconfig.co/json` on the host (outside the ns) returns the **home clearnet IP**.
- [ ] `GET /api/system/vpn-health` from a LAN client returns `{ mode: "vpn", publicIp: <VPN IP>, country: <XX>, leaking: false, reachable: true, lastCheckedAt: <recent ms> }`.
- [ ] TorrentDay search from the UI returns non-empty results with the box's system-level VPN OFF (proves the netns split does the work).
- [ ] All other sources (YTS, Knaben, Stremio addons, OMDb) still return results — no regression on sources that previously worked on clearnet.

### Regression

- [ ] LAN browsers still reach `http://<box>:3000` (Discovery, Library, Player, Settings all load).
- [ ] Chromecast discovery works: `/api/cast/devices` lists the LAN Chromecast within 5s of a page load.
- [ ] End-to-end cast succeeds: **Interstellar → Master Llama** (same title used to close `media-mac-deploy`). Playback starts on the TV within 30s.
- [ ] Subtitles: cast a title with an SRT track; confirm the receiver fetches `/stream/:hash/subtitles/:idx` and displays cues.
- [ ] `knaben-fallback` DNS: search a title likely to trigger the fallback; confirm results still return (proves the DNS monkey-patch composes with the tunnel).

### Quality (security-critical)

- [ ] Kill-switch: `sudo ip netns exec castcrate-ns wg-quick down wg-castcrate`; trigger an indexer search from the UI. Confirm all of:
  - Search fails or hangs within 30s (no results returned).
  - `sudo tcpdump -n -i <lan_if> 'not port 22 and not port 3000 and not udp port 5353 and not udp port 51820'` shows **zero** packets to the indexer's IP during the search window.
  - `/api/system/vpn-health` reports `{ reachable: false }`.
  - Nav pill flips to UNREACHABLE within 60s of the next poll.
- [ ] Bring WG back up; confirm search recovers on the next attempt; pill goes green within 60s.
- [ ] `VPN_MODE=off` + `systemctl restart castcrate`:
  - `systemctl is-active castcrate-netns.service` reports `inactive` (not `failed`).
  - Fastify is bound to `0.0.0.0:3000` on the host: `sudo ss -tlnp | grep :3000` shows the node process outside the ns.
  - LAN UI still works.
  - `/api/system/vpn-health` returns `{ mode: "off", ... }` immediately.
  - TorrentDay search returns empty (regression to pre-feature baseline — this proves `off` is genuinely off).
- [ ] IPv6 sanity: `ip netns exec castcrate-ns ip -6 addr` shows only `::1` on `lo` disabled state; `curl -6 https://ifconfig.co/ip` inside the ns fails cleanly (no v6 leak surface).
- [ ] No credentials in the repo (`grep -rE "PrivateKey|PresharedKey|wg0\.conf" apps/ packages/ scripts/` returns nothing).
- [ ] Settings GET response does not include the WG private key, peer public key, or preshared key. `vpnConfigured` boolean only.

### Verification method (an evaluator runs these on the deployed box)

1. `ssh castcrate@<box>`.
2. `ip netns exec castcrate-ns curl -s https://ifconfig.co/json | jq .` → expect VPN IP + country.
3. `curl -s https://ifconfig.co/json | jq .` → expect home IP.
4. From a LAN laptop browser: open `http://<box>:3000`. Confirm nav pill shows green `VPN · <country>`.
5. From LAN laptop terminal: `curl -s http://<box>:3000/api/system/vpn-health | jq .` → verify shape.
6. In the UI: search "Interstellar". Pick a torrent. Cast to Master Llama. Confirm playback on TV.
7. In the UI: search a title known to have TorrentDay results. Confirm non-empty result count with source `"torrentday"`.
8. On the box: `sudo tcpdump -n -i <lan_if> 'not port 22 and not port 3000 and not udp port 5353 and not udp port 51820' &`; note the tcpdump PID.
9. On the box: `sudo ip netns exec castcrate-ns wg-quick down wg-castcrate`.
10. In the UI: trigger another search. Wait 30s. `sudo kill <tcpdump_pid>` and inspect output — expect zero non-filtered packets.
11. `curl -s http://<box>:3000/api/system/vpn-health | jq .` → expect `reachable: false`.
12. On the box: `sudo ip netns exec castcrate-ns wg-quick up wg-castcrate`. Wait 60s. Verify pill returns to green.
13. On the box: edit `apps/server/.env` → `VPN_MODE=off`; `sudo systemctl restart castcrate`. Verify byte-identical pre-feature behaviour.

Every step is observable — no "check the logs manually."

### Non-goals for DoD (out of scope, documented)

- No multi-VPN switcher UI.
- No OpenVPN support.
- No macOS/Windows netns (VPN_MODE=off is the local-dev story).
- No per-source routing.
- No Docker/gluetun packaging.
- No BitTorrent port-forwarding through the VPN.
- No IPv6.

---

## Testing Strategy

### Netns scripts

- Test both `netns-up.sh` and `netns-down.sh` on a throwaway Ubuntu 26.04 VM (Multipass / UTM).
- Test idempotency explicitly: `up; up; down; down` — no errors.
- `shellcheck scripts/*.sh` in CI (add to the CI workflow if not already there).
- No unit tests for the scripts — they're pure shell wrapping `ip` / `iptables` / `wg` primitives; the value is in the runbook execution.

### Route handler

- Vitest unit test for `/api/system/vpn-health` handler with a mocked `undici` request to `ifconfig.co`:
  - `mode=vpn`, response IP ≠ host IP → `{ leaking: false, reachable: true }`.
  - `mode=vpn`, response IP === host IP → `{ leaking: true }`.
  - `mode=vpn`, request times out → `{ reachable: false }`.
  - `mode=off` → short-circuit; no fetch call issued.
- Cache behaviour: second call within 30s hits the cache; `?refresh=1` forces a new fetch.

### End-to-end (manual, on the real box)

- Full cast regression: Interstellar → Master Llama, subtitles on.
- TorrentDay search returns non-empty results.
- Kill-switch verification with `tcpdump` on `<lan_if>`.

### Fail-closed test (explicit)

Documented in Phase 6 and DoD step 8–10. Requires `tcpdump` — not automatable in CI, executed on the box.

### `VPN_MODE=off` regression

Explicit runbook step in Phase 6. Verifies pre-feature behaviour is preserved byte-for-byte.

---

## Dependencies

### Host packages (installed on the deployed box via `apt`)

- `wireguard-tools` (`wg-quick`, `wg`)
- `iproute2` (`ip netns`, `ip link`) — usually pre-installed on Ubuntu Server
- `iptables-nft` — pre-installed on Ubuntu Server 26.04; ensure the `-nft` variant, not the legacy `-legacy` backend
- `curl` — for the boot-time host clearnet IP fingerprint (and general debugging)

Add all four to the `media-mac-deploy` Phase 3 apt install list (currently `ffmpeg avahi-daemon avahi-utils ufw mbpfan build-essential git curl` — extend to include `wireguard-tools iptables-nft`).

### User-provided

- A WireGuard config from a commercial provider (Mullvad account page, PIA WG generator, ProtonVPN downloads, AirVPN config generator). Minimal required fields:
  - `[Interface]` block: `PrivateKey`, `Address` (typically `10.x.x.x/32` or similar)
  - `[Peer]` block: `PublicKey`, `Endpoint`, `AllowedIPs = 0.0.0.0/0` (route everything via the tunnel — the ns's exception routes will carve out LAN/multicast on top)
- Provider-specific extensions (`PresharedKey`, `PersistentKeepalive`, `DNS`) are supported by `wg-quick` transparently; `DNS =` is ignored by our setup because we don't touch `/etc/resolv.conf` inside the ns (see Risk 3).

### Repo coordination

- `torrentday-indexer` — primary motivator; verified in DoD step 7.
- `hardening` — kill-switch behaviour aligns with hardening's security bar; the `shutdownTranscodes()` hook from `hardening` must fire on SIGTERM *before* the netns unit tears down (systemd default ordering `castcrate.service` stops before `castcrate-netns.service` because of the dep chain — verified in Phase 2).
- `media-mac-deploy` — folds in as Phase 8; touches the deploy runbook + apt install list.
- `chromecast` + `cast-controls` — mDNS + inbound TCP verified in Phase 3.
- `knaben-fallback` — DNS monkey-patch composition verified in Phase 6.
- `proxy-routing` (spec, not built) — coexistence documented in Key Decisions #9.
- `library-settings` — Settings UI Network / VPN section added in Phase 5.
- All other siblings (`yts-streaming`, `stremio-addon-source`, `omdb-search`, `discovery`, `tv-shows`, `tmdb-metadata` planned, `subtitles`, `transcoding`, `player-buffer-ux`, `player-controls`, `dev-ops`, `scaffold`) — no integration change; transparent benefit or unaffected.

---

## Risks & Mitigation

### R1. Systemd sandbox × `ip netns exec` interaction

**Risk:** `ProtectSystem=strict` + `ProtectHome=read-only` + `ip netns exec` interact non-obviously; the tilde-footgun from `media-mac-deploy` proved this surface is a bug magnet.

**Mitigation:**
- All paths in unit files are **absolute**. No tildes anywhere.
- The `run-server.sh` trampoline is where we do any env-dependent branching (VPN_MODE gate), keeping the unit file itself dumb.
- `StateDirectory=castcrate` provides a systemd-managed writable path if we need it.
- Phase 2 explicitly verifies `journalctl` shows no `denied` / `read-only` errors on start and stop.
- Ordering learned from `media-mac-deploy`: no relative paths, no shell substitution in `ExecStart=`.

### R2. Chromecast mDNS + inbound TCP failing inside ns

**Risk:** `bonjour-service` uses UDP multicast (`224.0.0.251:5353`) for discovery; the Chromecast then opens TCP to the server for cast control and HTTP stream fetches. Any of those paths breaking = feature-blocking regression.

**Mitigation:**
- Multicast exception route (`224.0.0.0/4 via 10.200.200.1`) in the ns lets mDNS out and back in via the veth.
- Host DNAT rule (`<lan_if>:3000 → 10.200.200.2:3000`) republishes the Fastify listener to the LAN.
- `CASTCRATE_LAN_IP` env override ensures the receiver-side URL construction uses the LAN IP the Chromecast can actually reach (not the internal `10.200.200.2`).
- Phase 3 explicitly runs the full end-to-end cast on the VM before touching the real box. If mDNS doesn't work through the veth, we find out with a disposable VM.

### R3. `dns.lookup` monkey-patch from `knaben-fallback` interacting with the tunnel

**Risk:** `knaben-fallback` monkey-patches `dns.lookup` process-wide to Cloudflare (1.1.1.1). If the ns's `resolv.conf` or routing interferes, either the fallback breaks or DNS leaks bypass the tunnel.

**Mitigation:**
- We do **not** modify `/etc/resolv.conf` inside the ns. `knaben-fallback` uses `dns.setServers(["1.1.1.1", "1.0.0.1"])` explicitly, so `resolv.conf` is irrelevant — it always talks to `1.1.1.1` directly.
- Inside the ns, `1.1.1.1` is not in the RFC1918 exception set → it takes the WG default route → the DNS query exits via the tunnel to the WG peer → the peer forwards to Cloudflare.
- Verified explicitly in Phase 6 with `tcpdump -i <lan_if>` on the host: zero UDP to `1.1.1.1:53` observed.
- Documented outcome: `knaben-fallback` and `vpn-split-tunnel` compose correctly with no code change to either.

### R4. `wg0.conf` provider variance

**Risk:** Different providers ship configs with slightly different field ordering, extensions, or DNS handling. A config that works with `wg-quick` on the user's laptop might behave differently inside a netns.

**Mitigation:**
- Document the required minimal fields in the runbook (Interface: `PrivateKey`, `Address`; Peer: `PublicKey`, `Endpoint`, `AllowedIPs`).
- `wg-quick` handles most provider extensions (`PresharedKey`, `PersistentKeepalive`) transparently.
- `DNS =` lines are ignored by our setup (see R3) — this is a *feature*, not a bug, because it prevents providers from silently rewriting the ns's DNS.
- Skip provider-specific extensions like Mullvad's `[Interface] DNS = 10.64.0.1` (Mullvad's own resolver) — the tunnel is the interesting property, not their resolver.
- If a provider's config genuinely doesn't work, `netns-up.sh` fails loudly (via `set -euo pipefail`) at the `wg` setconf step — deterministic failure, easy to diagnose.

### R5. WG interface flapping / peer rotation

**Risk:** VPN providers occasionally rotate keys or drop peers; the WG interface may go down mid-session.

**Mitigation:**
- `/api/system/vpn-health` polling from the UI (60s) surfaces the state so the user sees it.
- `castcrate-netns.service` has no `Restart=` policy by default (it's a `oneshot`), but we can add `Restart=on-failure` + `RestartSec=30s` to the netns unit if flapping proves common. YAGNI: ship without it, add if the runbook execution reveals a real problem.
- Fail-closed kill switch means a dropped tunnel is user-visible (search fails, pill goes red) rather than silently leaking.

### R6. IPv6 leaks

**Risk:** If IPv6 is enabled inside the ns without a v6 default route, connections may fall through to a v6 clearnet path or fail unpredictably.

**Mitigation:**
- Explicitly `sysctl -w net.ipv6.conf.{all,default,lo}.disable_ipv6=1` inside the ns in `netns-up.sh`.
- Verify with `ip -6 addr` (empty list) and a `curl -6` test (should fail).
- WG config uses v4-only `AllowedIPs = 0.0.0.0/0` (not `::/0`).

### R7. Orphaned ffmpeg on ns teardown

**Risk:** Stopping `castcrate-netns.service` while Fastify is still transcoding could orphan the ffmpeg subprocesses (netns gone, but processes still exist in a broken routing state).

**Mitigation:**
- systemd dep chain guarantees `castcrate.service` stops **before** `castcrate-netns.service` (per `Requires=`/`Wants=` + `After=` semantics).
- `hardening` Phase B2 (`shutdownTranscodes()` on `onClose`) fires during Fastify's shutdown — ffmpeg processes killed before the netns tears down.
- Verify in Phase 6: `sudo systemctl restart castcrate; pgrep -f ffmpeg` returns nothing after a shutdown-during-transcode test.

### R8. iptables rule collision on shared boxes

**Risk:** If the box already has iptables rules (from `ufw` in `media-mac-deploy` Phase 3, or another service), our `-t nat -A PREROUTING` rule might interact with theirs.

**Mitigation:**
- `ufw` operates on `filter/INPUT`, `filter/OUTPUT`, `filter/FORWARD` — not `nat/PREROUTING`. No conflict.
- `netns-down.sh` uses matching `-D` to remove the exact rule; leaves other rules alone.
- Document in the runbook: any user who adds custom `nat/PREROUTING` rules is responsible for verifying interaction.

### R9. Lockout risk during runbook execution

**Risk:** A typo in `netns-up.sh` or `iptables` on the deployed box could lock the user out over SSH.

**Mitigation:**
- Explicit tcpdump filter excludes `port 22` — we never touch SSH traffic.
- `castcrate-netns.service` is a separate unit from SSH; disabling it does not affect `sshd`.
- Runbook Phase 7 step: verify SSH still works after each of steps 8, 9, 12 (post-enable, post-restart, post-cast).
- Fallback: user can physically get to the box (2011 MBP, same room as the router) and rescue via console if SSH breaks.

---

## Quality Bar

- **Zero application code change in unrelated features.** If any feature (torrentday-indexer, stremio-addon-source, subtitles, etc.) needs to know whether it's behind a VPN, this design is wrong — reconsider. The only new server-side code lives in the health endpoint + config plumbing.
- **No credential handling in the app.** `wg0.conf` sits at `/etc/castcrate/wg0.conf` (mode 600, root:root). Never in the repo, never in logs, never in the `/api/settings` GET response, never in `/api/system/vpn-health` (peer public key is fine to expose; private key never).
- **Idempotent scripts.** `netns-up.sh` runs twice without error; `netns-down.sh` handles the "already torn down" case gracefully. Both scripts pass `set -euo pipefail` + `shellcheck`; log every step with a prefix. The tilde-footgun and silent-swallow learnings from `media-mac-deploy` apply verbatim.
- **Visible failure states in UI.** UI shows LEAKING / UNREACHABLE explicitly. If the VPN drops, the user notices from any screen — not by wondering why TorrentDay returns 0 results again.
- **Reproducible on any Ubuntu Server 26.04 host** from the runbook alone. No hidden state, no undocumented env vars.
- **Testable in isolation.** The `/api/system/vpn-health` route logic is unit-tested with a mocked HTTP client; the netns scripts are testable on any Ubuntu VM without CastCrate installed. Kill-switch is verifiable with `tcpdump` on the box.
- **Absolute paths in all deploy artefacts.** No tildes in unit files, wrapper scripts, or env files (`EnvironmentFile=` expands tildes to `/root/~/…` under the sandbox — the exact bug that bit `media-mac-deploy`).
