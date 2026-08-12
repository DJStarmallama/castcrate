#!/usr/bin/env bash
#
# netns-down.sh — Teardown of the castcrate-ns network namespace.
#
# Reverses netns-up.sh in the safe order:
#   1. Remove host iptables nat/PREROUTING DNAT rule(s) that target :3000
#      inside the ns (scan iptables-save so we catch rules whose -i interface
#      has changed since the up ran — e.g. LAN interface renamed).
#   2. Delete the WireGuard interface inside the ns (also drops its routes).
#   3. Delete the veth pair (deleting one end deletes both).
#   4. Delete the namespace.
#
# Every step is guarded ("if exists, remove; else silently continue") so a
# second invocation is a no-op. Absolute paths only — no reliance on $PATH.
#
# See docs/features/castcrate/vpn-split-tunnel/implementation.md Phase 1.

set -euo pipefail

NS="castcrate-ns"
VETH_HOST="veth-cc-host"
WG_IF="wg-castcrate"
NS_INNER_IP="10.200.200.2"
DNAT_PORT="3000"

IP=/usr/sbin/ip
IPTABLES=/usr/sbin/iptables

log() { echo "[netns-down] $*"; }

# ----- 1. Host DNAT teardown --------------------------------------------------
#
# Scan iptables-save for any PREROUTING rule whose --to-destination targets our
# ns-side IP and port, and delete each. This is more robust than trying to
# reconstruct the exact -A line from the current default-route interface
# (which may have changed between up and down).
if command -v /usr/sbin/iptables-save >/dev/null 2>&1; then
  IPT_SAVE=/usr/sbin/iptables-save
else
  IPT_SAVE=iptables-save
fi

MATCHES="$($IPT_SAVE -t nat 2>/dev/null | grep -E '^-A PREROUTING .*--to-destination '"${NS_INNER_IP}:${DNAT_PORT}"'$' || true)"
if [ -n "$MATCHES" ]; then
  while IFS= read -r rule; do
    # Convert "-A PREROUTING ..." to "-D PREROUTING ..." and execute.
    del_rule="${rule/#-A /-D }"
    log "removing DNAT rule: $del_rule"
    # shellcheck disable=SC2086  # word-splitting is intentional here
    $IPTABLES -t nat $del_rule 2>/dev/null || log "  (rule already gone)"
  done <<< "$MATCHES"
else
  log "no matching DNAT rule found on host (already clean)"
fi

# ----- 2. WireGuard interface inside ns --------------------------------------
if $IP netns list 2>/dev/null | awk '{print $1}' | grep -qx "$NS"; then
  if $IP -n "$NS" link show "$WG_IF" >/dev/null 2>&1; then
    log "deleting $WG_IF inside $NS"
    $IP -n "$NS" link del "$WG_IF" 2>/dev/null || log "  ($WG_IF already gone)"
  else
    log "$WG_IF not present in $NS (already clean)"
  fi
else
  log "$NS namespace does not exist (nothing to clean inside ns)"
fi

# ----- 3. veth pair -----------------------------------------------------------
if $IP link show "$VETH_HOST" >/dev/null 2>&1; then
  log "deleting veth pair via $VETH_HOST (removes both ends)"
  $IP link del "$VETH_HOST" 2>/dev/null || log "  ($VETH_HOST already gone)"
else
  log "$VETH_HOST not present (already clean)"
fi

# ----- 4. Namespace -----------------------------------------------------------
if $IP netns list 2>/dev/null | awk '{print $1}' | grep -qx "$NS"; then
  log "deleting namespace $NS"
  $IP netns del "$NS" 2>/dev/null || log "  ($NS already gone)"
else
  log "$NS namespace does not exist (nothing to delete)"
fi

log "$NS is down"
