# vpn-split-tunnel — Requirements

**Epic:** castcrate
**Created:** 2026-08-11
**Motivation:** Some torrent sources (notably TorrentDay) block or silently return empty results when accessed without a VPN; others (YTS, Knaben) are happy on clearnet. Today the user has to remember to flip a system VPN on before searching and off before casting — and any system-wide VPN they enable breaks Chromecast LAN discovery. This feature makes VPN routing an intrinsic property of the CastCrate service: indexer + torrent traffic always exits through a VPN, while the LAN-facing HTTP stream that Chromecast needs to reach always exits on the host interface.

## Overview

Run the CastCrate server inside a Linux **network namespace** whose default route is a WireGuard tunnel. A veth pair connects the namespace to the host so LAN destinations (Chromecast, browsers on the same subnet) can still reach the server on `:3000`. The user supplies their own `wg0.conf` from any commercial provider (Mullvad, PIA, ProtonVPN, AirVPN — anything that ships WireGuard); CastCrate provides the systemd units, netns scripts, `/health/vpn` endpoint, and UI panel that stitch it together.

## Requirements

- Provision a namespace `castcrate-ns` on service start, with:
  - A veth pair (`veth-cc-host` on the host, `veth-cc-ns` inside the ns).
  - WireGuard interface `wg-castcrate` inside the ns, using the user-supplied config at `/etc/castcrate/wg0.conf` (mode 600, root-owned).
  - Default route inside the ns via `wg-castcrate` — all non-LAN egress goes over VPN.
  - LAN exception routes inside the ns for RFC1918 destinations (`10/8`, `172.16/12`, `192.168/16`) plus the multicast subnet (`224.0.0.0/4`) via the veth pair, so mDNS + Chromecast + LAN browsers stay reachable.
- Add a systemd unit `castcrate-netns.service` (`Type=oneshot`, `RemainAfterExit=yes`) that runs `scripts/netns-up.sh` on start and `scripts/netns-down.sh` on stop.
- `castcrate.service` gains `After=castcrate-netns.service` + `Requires=castcrate-netns.service`, and its `ExecStart` runs Fastify inside the namespace (`ip netns exec castcrate-ns node …`).
- Host publishes port 3000 to the LAN via an iptables `DNAT` from `host_lan_ip:3000` → `veth-cc-ns_ip:3000`, so LAN clients still hit `192.168.x.x:3000` unchanged.
- **Fail-closed kill switch** — if `wg-castcrate` drops (peer unreachable, key rotation, provider outage), the ns's default route points at a dead interface; outbound requests hang / fail rather than leak to clearnet. Server logs a WARN on egress failure.
- New endpoint `GET /health/vpn` returns `{ mode, publicIp, country, wgPeer, reachable, leaking }`. Runs inside the ns, so its own HTTP lookup naturally exits via VPN; compares against the host's clearnet IP (captured at boot) to detect leaks.
- Settings UI gains a "VPN" panel — mode badge (VPN / OFF / LEAKING), exit country + flag, WG peer, refresh button. A small status pill in the top nav is visible on every screen so a leak is not missable.
- Chromecast discovery (mDNS via `castv2-client`) continues to work with the ns active. Explicitly regression-tested end-to-end (find Chromecast → cast → play).
- `VPN_MODE=off` (or the absence of `/etc/castcrate/wg0.conf`) is a first-class mode: the netns unit degrades to a no-op, Fastify runs on the host as before. Zero feature-code change.
- Runbook: `media-mac-deploy` gains **Phase 8: VPN split-tunnel** — install `wireguard-tools`, drop WG config, enable the netns unit, verify `/health/vpn`, verify Chromecast still casts.

## Dependencies

- **Host packages:** `wireguard-tools` (`wg-quick`, `wg`), `iproute2` (`ip netns`, `ip link`), `iptables-nft`. All standard on Ubuntu Server 26.04 — add to the `media-mac-deploy` apt install list.
- **User-provided:** a WireGuard config from a commercial VPN provider (Mullvad account page, PIA WG generator, ProtonVPN downloads, AirVPN config generator).
- **Repo:** touches `apps/server/src/routes/health.ts` (new `/health/vpn`), `apps/server/src/server.ts` (route registration), `apps/server/src/services/settings.ts` (read-only VPN fields), `apps/web/src/components/Settings.tsx` (VPN panel), `apps/web/src/components/TopNav.tsx` (status pill), `packages/shared/src/index.ts` (`VpnHealth` type), `scripts/netns-up.sh` + `scripts/netns-down.sh` (new), `deploy/systemd/castcrate-netns.service` (new), `deploy/systemd/castcrate.service` (dep edit + exec wrapper), `docs/features/castcrate/media-mac-deploy/tasks.md` (Phase 8).
- **Existing features to coordinate with:**
  - `torrentday-indexer` — the primary reason this feature exists. "0 results" debugging becomes "check `/health/vpn` first."
  - `stremio-addon-source`, `knaben-fallback`, `yts-streaming` — now transparently egress via VPN. If a source ever geoblocks a specific exit country, the fix is to pick a different WG endpoint, not a code change.
  - `chromecast`, `cast-controls` — must keep working on LAN. Regression test the mDNS + castv2 flow with the ns active.
  - `hardening` — kill-switch behaviour aligns with hardening's security bar (fail-closed, no leaks).
  - `media-mac-deploy` — gains Phase 8; deploy-adjacent by nature.

## Out of Scope

- Multi-VPN / provider selector UI. User edits `wg0.conf` on the box; no in-app switcher in v1.
- OpenVPN support. WireGuard only — every serious provider ships WG now and WG is dramatically simpler to run in a namespace.
- macOS / Windows host support. netns is Linux-only; deploy target is Ubuntu 26.04. Local dev on macOS runs with `VPN_MODE=off`.
- Per-source routing (e.g. "route TorrentDay via VPN, YTS via clearnet"). Whole-server-in-ns is simpler; clearnet queries over VPN are fine and even privacy-preferable.
- Docker / gluetun packaging. Considered and rejected — the deploy is native systemd; adding a container runtime is a much larger change than a netns.
- BitTorrent peer-port forwarding through the VPN (for higher peer counts). Provider-specific; Mullvad recently dropped port-forwarding entirely. Defer.
- IPv6. WG in the ns is v4-only in v1.

---

*Consumed by `/plan-feature castcrate/vpn-split-tunnel`. See `implementation.md` for the planning notes drafted alongside these requirements; run `/plan-feature` when ready for the full solution-architect pass.*
