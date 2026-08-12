#!/usr/bin/env bash
#
# run-server.sh — CastCrate Fastify server launcher with VPN_MODE gate.
#
# Called by castcrate.service. This script owns the VPN_MODE decision:
#   VPN_MODE=vpn  → exec node inside castcrate-ns (all outbound egress via WG)
#   VPN_MODE=off  → exec node on the host directly (byte-identical to
#                   pre-vpn-split-tunnel behaviour; the local-dev and
#                   opt-out path)
#
# The systemd unit's ExecStart= invokes this script WITHOUT any `ip netns exec`
# prefix — the ns entry (or lack of it) is decided here, not in the unit file.
# That's what lets the same systemd unit ship in both configurations.
#
# Absolute paths only — no tildes, no reliance on $PATH. systemd runs with a
# minimal PATH, and EnvironmentFile= does not expand `~` (see the media-mac-deploy
# "Bug B" tilde-footgun and this file's sibling castcrate.service header).
#
# See docs/features/castcrate/vpn-split-tunnel/implementation.md Phases 2 + 6.

set -euo pipefail

NODE=/usr/bin/node
ENTRY=/home/castcrate/castcrate/apps/server/dist/index.js

if [ "${VPN_MODE:-off}" = "vpn" ]; then
  >&2 echo "[run-server] VPN_MODE=vpn → exec node inside castcrate-ns"
  exec /usr/sbin/ip netns exec castcrate-ns "$NODE" "$ENTRY"
else
  >&2 echo "[run-server] VPN_MODE=${VPN_MODE:-off} → exec node on host (no ns)"
  exec "$NODE" "$ENTRY"
fi
