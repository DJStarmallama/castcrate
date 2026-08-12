# vpn-torrentday-only — Requirements

**Epic:** castcrate
**Created:** 2026-08-12
**Successor to:** `vpn-split-tunnel` (v1)
**Motivation:** Deploying `vpn-split-tunnel` v1 on the 2011 MBP box proved the design works (WG tunnel handshakes, indexer + torrent traffic routed via VPN, egress split verified). But the throughput cost is real — full-tunnel routes torrent peer connections + DHT + tracker HTTPS through IPVanish's Amsterdam exit, adding ~250ms RTT (Sydney→AMS) and gating on the provider's link + peer connectivity through their NAT. Result: choppy playback while streaming-as-you-download.

Real-world workflow insight from the user: with a manual torrent client + system VPN, you toggle VPN ON only to fetch the `.torrent` from TorrentDay's site (which blocks non-VPN access), then toggle VPN OFF to let peer connections flow on clearnet at full speed. CastCrate can't do this today because the whole server lives in the ns.

## Overview

Rework the VPN feature so the server runs on the HOST (clearnet), and **only TorrentDay adapter HTTP calls** are routed through the WG tunnel via a subprocess-in-ns pattern. Everything else — WebTorrent peer connections, tracker HTTPS for other sources (YTS/Knaben/Stremio), OMDb, TMDB, subtitle fetches, Chromecast, LAN clients — uses the host's normal clearnet path. Zero throughput cost for downloads, TorrentDay site access still works because only its fetches go via VPN.

Keeps the netns + WG infrastructure from v1 (reused, not thrown away). Loses the "all outbound is VPN'd" privacy property from v1 — this feature explicitly trades that for throughput. Users who want full-tunnel privacy keep `VPN_MODE=vpn` (v1 mode); users who want peer-throughput-plus-TorrentDay-access use the new `VPN_MODE=torrentday-only` (v2 mode).

## Requirements

- Add a new `VPN_MODE` value: `torrentday-only`. Existing `vpn` (full-tunnel, v1) and `off` (no VPN) values continue to work unchanged.
- When `VPN_MODE=torrentday-only`:
  - `castcrate-netns.service` still runs (WG tunnel + resolv.conf inside ns), but the server itself runs on the host, NOT inside the ns.
  - `run-server.sh` runs Fastify on the host directly (byte-identical to `VPN_MODE=off` in terms of process placement — no `ip netns exec` prefix).
  - The TorrentDay adapter routes ALL its HTTP calls (search page fetches, `.torrent` blob downloads, `/api/torrentday/test` health probe) through a subprocess that runs inside `castcrate-ns` via `ip netns exec castcrate-ns node /opt/castcrate/scripts/td-fetcher.js <url>`. The subprocess returns the response body (bytes) via stdout to the parent Fastify process.
  - All other outbound (WebTorrent, other adapters, metadata, subtitles) uses normal host clearnet — no ns entry.
- `td-fetcher.js` is a tiny standalone Node script (no imports beyond the built-in `node:https` / `node:http`) that takes a URL as argv, fetches it with the current TorrentDay session cookies passed via env, writes the response body to stdout, exits 0 on success or non-zero on error.
- Simplified netns setup: `netns-up.sh` when `VPN_MODE=torrentday-only` skips the veth pair, host DNAT rule, and FORWARD ACCEPT rules — none of them are needed since no LAN traffic enters the ns. Keeps: namespace creation, IPv6 disable, WG interface creation + config + default route, per-ns resolv.conf. Both modes (v1 full-tunnel and v2 selective) supported by the same `netns-up.sh` (branches on env).
- `/api/system/vpn-health` continues to work in `torrentday-only` mode: the probe subprocess (same td-fetcher pattern) hits `https://1.1.1.1/cdn-cgi/trace` inside the ns to confirm the tunnel is up. `mode` field returns `"torrentday-only"` (new value in the shared type).
- Settings UI shows the new mode option; nav pill label changes based on mode: `VPN · NL` (full-tunnel), `TD-only · NL` (selective), `OFF` (off), `LEAK` (leaking), `?` (unreachable).
- No regression on `VPN_MODE=off` or `VPN_MODE=vpn` — both continue to work exactly as v1 defined.
- Runbook: `media-mac-deploy` Phase 8's `.env` section documents the three `VPN_MODE` values with a short "pick this if..." guide.

## Dependencies

- **v1 infrastructure**: this feature depends on `vpn-split-tunnel` v1 being deployed (netns unit, wg0.conf at `/etc/castcrate/wg0.conf`, scripts at `/opt/castcrate/scripts/`, `HOST_CLEARNET_IP` env). This is an evolution, not a from-scratch build.
- **Repo**: touches `apps/server/src/services/torrentday.ts` (route fetches via subprocess when mode is `torrentday-only`), `apps/server/src/services/vpn-health.ts` (support new mode's probe path), `apps/server/src/lib/config.ts` (accept new VPN_MODE value), `packages/shared/src/index.ts` (extend `VpnMode` type), `scripts/td-fetcher.js` (new), `scripts/run-server.sh` (extend gate for three modes), `scripts/netns-up.sh` (skip veth/DNAT/FORWARD in selective mode), `apps/web/src/components/{Settings.tsx,VpnStatusPill.tsx}` (surface new mode label), `.env.example` (document new value), `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 8 (update runbook).
- **Existing features to coordinate with**:
  - `torrentday-indexer` — primary consumer. Its HTTP client swaps out for the subprocess pattern under the new mode.
  - `vpn-split-tunnel` v1 — coexists (three-mode config); no code from v1 is removed.
  - `proxy-routing` (spec, not built) — related but different: proxy-routing is per-source SOCKS/HTTP proxy dispatch inside the server process; this feature is per-source out-of-process VPN routing. They can coexist.

## Out of Scope

- Multi-source selective VPN (e.g., "route TorrentDay + Redacted via VPN, everything else clearnet"). v1 of this feature is TorrentDay-only. Additional sources can extend the pattern later if we add more private trackers.
- SOCKS5 proxy inside the ns (rejected in favor of the subprocess pattern — simpler, no long-running daemon, no proxy port to secure).
- Removing v1 full-tunnel mode. `VPN_MODE=vpn` stays for users who prioritize outbound-traffic privacy over throughput.
- Kill-switch semantics for v2 mode: if the tunnel is down, TorrentDay fetches fail (subprocess errors), which is the correct fail-closed behavior for just the TD flow. Other sources continue to work (they're on clearnet). This is intentional — a v2-mode user has already opted for reduced privacy.
- Auto-detection or migration of `VPN_MODE=vpn` users to `torrentday-only`. Existing users keep whatever they set.

---

*Consumed by `/plan-feature castcrate/vpn-torrentday-only`. See `implementation.md` for the planning notes drafted alongside these requirements; run `/plan-feature` when ready for the full solution-architect pass.*
