#!/usr/bin/env bash
#
# run-server.sh — CastCrate Fastify server launcher with three-way VPN_MODE gate.
#
# Called by castcrate.service. This script owns the VPN_MODE decision:
#
#   VPN_MODE=vpn              → exec node INSIDE castcrate-ns (all outbound
#                               egress via WG; v1 semantics, unchanged).
#   VPN_MODE=torrentday-only  → exec node on the HOST (Fastify runs on
#                               clearnet at full throughput; TorrentDay adapter
#                               spawns its own `ip netns exec` per fetch, see
#                               apps/server/src/services/torrentday-fetch.ts).
#   VPN_MODE=off (or unset)   → exec node on the HOST (byte-identical to
#                               pre-vpn-split-tunnel behaviour; macOS-dev and
#                               opt-out path).
#   Anything else             → hard error; exits non-zero. Systemd will report
#                               `failed`, which is the correct "loud" signal.
#
# The systemd unit's ExecStart= invokes this script WITHOUT any `ip netns exec`
# prefix — the ns entry (or lack of it) is decided here, not in the unit file.
# That's what lets the same systemd unit ship in all three configurations.
#
# Absolute paths only — no tildes, no reliance on $PATH. systemd runs with a
# minimal PATH, and EnvironmentFile= does not expand `~` (see the media-mac-deploy
# "Bug B" tilde-footgun and this file's sibling castcrate.service header).
#
# See docs/features/castcrate/vpn-split-tunnel/implementation.md Phases 2 + 6
# and docs/features/castcrate/vpn-torrentday-only/implementation.md Phase 4.

set -euo pipefail

NODE=/usr/bin/node
ENTRY=/home/castcrate/castcrate/apps/server/dist/index.js

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
    >&2 echo "[run-server] ERROR: unknown VPN_MODE=${VPN_MODE} (must be vpn|torrentday-only|off)"
    exit 1
    ;;
esac
