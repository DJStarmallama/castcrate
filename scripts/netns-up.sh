#!/usr/bin/env bash
#
# netns-up.sh — Idempotent setup of the castcrate-ns network namespace.
#
# Creates:
#   - Linux network namespace: castcrate-ns
#   - veth pair: veth-cc-host (host, 10.200.200.1/30) <-> veth-cc-ns (ns, 10.200.200.2/30)
#   - WireGuard interface wg-castcrate inside the ns (config: /etc/castcrate/wg0.conf)
#   - Four exception routes inside the ns (RFC1918 + multicast) via the veth
#   - Default route inside the ns via wg-castcrate
#   - Host iptables nat/PREROUTING DNAT rule republishing :3000 into the ns
#
# All operations are guarded so a second invocation is a no-op.
#
# Requires: root, wireguard-tools, iproute2, iptables-nft.
# Absolute paths only — no reliance on $PATH (systemd runs with a minimal one).
# See docs/features/castcrate/vpn-split-tunnel/implementation.md Phase 1.

set -euo pipefail

# --- Absolute paths (Ubuntu 26.04 defaults) ----------------------------------
# If any of these differ on a future distro, add fallbacks here. Do NOT rely on
# $PATH — the tilde-footgun class of bugs from media-mac-deploy applies here.
IP=/usr/sbin/ip
IPTABLES=/usr/sbin/iptables
SYSCTL=/usr/sbin/sysctl
WG=/usr/bin/wg
# wg-quick is intentionally NOT invoked as a subprocess — Ubuntu ships an
# AppArmor profile for wg-quick that confines its reads to /etc/wireguard/*.conf,
# which would break our /etc/castcrate/wg0.conf layout. We do the equivalent
# `strip` in-script with grep -v (see step 7 below).

# --- Config -----------------------------------------------------------------
NS=castcrate-ns
VETH_HOST=veth-cc-host
VETH_NS=veth-cc-ns
HOST_ADDR=10.200.200.1/30
NS_ADDR=10.200.200.2/30
HOST_GW=10.200.200.1
WG_IF=wg-castcrate
WG_CONF=/etc/castcrate/wg0.conf
DNAT_PORT=3000
DNAT_TARGET=10.200.200.2:3000

log() { echo "[netns-up] $*"; }
die() { echo "[netns-up] ERROR: $*" >&2; exit 1; }

# --- Preconditions ----------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  die "must run as root (needs CAP_NET_ADMIN + iptables)"
fi

for bin in "$IP" "$IPTABLES" "$SYSCTL" "$WG"; do
  if [ ! -x "$bin" ]; then
    die "required binary not found or not executable: $bin (install wireguard-tools iproute2 iptables-nft)"
  fi
done

if [ ! -r "$WG_CONF" ]; then
  die "WireGuard config missing or unreadable: $WG_CONF (drop your provider's wg0.conf there, mode 600, root:root)"
fi

# --- Detect LAN interface at runtime ----------------------------------------
LAN_IF="$($IP route show default | awk '/default/ {print $5; exit}')"
if [ -z "${LAN_IF:-}" ]; then
  die "could not detect LAN interface from default route (is the box online?)"
fi
log "detected LAN interface: $LAN_IF"

# --- Step 1: namespace ------------------------------------------------------
if $IP netns list | awk '{print $1}' | grep -qx "$NS"; then
  log "namespace $NS already exists — skipping create"
else
  log "creating namespace $NS"
  $IP netns add "$NS"
fi

# --- Step 2: IPv6 disable inside the ns (BEFORE any interface config) --------
# Rationale: dual-stack multiplies leak surface. WG config uses AllowedIPs=0.0.0.0/0
# (v4 only); disabling v6 in the ns prevents kernel from auto-configuring any
# link-local v6 addresses that could otherwise fall through routing.
log "disabling IPv6 inside $NS"
$IP netns exec "$NS" "$SYSCTL" -q -w net.ipv6.conf.all.disable_ipv6=1
$IP netns exec "$NS" "$SYSCTL" -q -w net.ipv6.conf.default.disable_ipv6=1
$IP netns exec "$NS" "$SYSCTL" -q -w net.ipv6.conf.lo.disable_ipv6=1

# --- Step 3: bring up loopback inside the ns --------------------------------
if $IP -n "$NS" link show lo | grep -q "state UP"; then
  log "lo already up inside $NS — skipping"
else
  log "bringing up lo inside $NS"
  $IP -n "$NS" link set lo up
fi

# --- Step 4: veth pair ------------------------------------------------------
# The host end may exist from a previous run; the ns end lives inside the ns.
if $IP link show "$VETH_HOST" &>/dev/null; then
  log "veth pair already exists ($VETH_HOST on host) — skipping create"
else
  log "creating veth pair: $VETH_HOST <-> $VETH_NS"
  $IP link add "$VETH_HOST" type veth peer name "$VETH_NS"
fi

# Move the ns-side veth into the ns if it's still on the host.
if $IP link show "$VETH_NS" &>/dev/null; then
  log "moving $VETH_NS into $NS"
  $IP link set "$VETH_NS" netns "$NS"
elif $IP -n "$NS" link show "$VETH_NS" &>/dev/null; then
  log "$VETH_NS already inside $NS — skipping move"
else
  die "$VETH_NS is neither on host nor in $NS (corrupted state — run netns-down.sh)"
fi

# --- Step 5: address assignment on the veth ---------------------------------
if $IP addr show dev "$VETH_HOST" | grep -q "inet ${HOST_ADDR%/*}/"; then
  log "$VETH_HOST already has $HOST_ADDR — skipping"
else
  log "assigning $HOST_ADDR to $VETH_HOST"
  $IP addr add "$HOST_ADDR" dev "$VETH_HOST"
fi

if $IP -n "$NS" addr show dev "$VETH_NS" | grep -q "inet ${NS_ADDR%/*}/"; then
  log "$VETH_NS already has $NS_ADDR — skipping"
else
  log "assigning $NS_ADDR to $VETH_NS"
  $IP -n "$NS" addr add "$NS_ADDR" dev "$VETH_NS"
fi

log "bringing veth pair up"
$IP link set "$VETH_HOST" up
$IP -n "$NS" link set "$VETH_NS" up

# --- Step 6: WireGuard interface --------------------------------------------
# Create the WG interface on the host, then move it into the ns. This is the
# standard netns+WG idiom — WG interfaces can be moved after creation and this
# is the most reliable way to get one inside a namespace.
if $IP -n "$NS" link show "$WG_IF" &>/dev/null; then
  log "$WG_IF already exists inside $NS — skipping create"
else
  if $IP link show "$WG_IF" &>/dev/null; then
    log "$WG_IF exists on host (orphan from prior run) — moving into $NS"
    $IP link set "$WG_IF" netns "$NS"
  else
    log "creating $WG_IF on host, then moving into $NS"
    $IP link add "$WG_IF" type wireguard
    $IP link set "$WG_IF" netns "$NS"
  fi
fi

# --- Step 7: WireGuard configuration ----------------------------------------
# Produce a wg-compatible config (drops [Interface] Address / DNS / MTU / Table
# / Pre*Up / Post*Down / SaveConfig lines that `wg setconf` doesn't understand)
# and apply with `wg setconf` inside the ns.
#
# We deliberately do NOT use `wg-quick` here — not even `wg-quick strip`.
# Ubuntu's default AppArmor profile confines wg-quick to reads from
# /etc/wireguard/*.conf only, which breaks our /etc/castcrate/wg0.conf layout.
# We're already root and unconfined; a shell-native strip does the same job
# without pulling AppArmor into the picture.
#
# We also don't use `wg-quick up` — it fights netns-vs-host route ownership
# (it would add its own default route in the caller's ns). Manual setconf
# gives us explicit control over routing.
log "applying WireGuard config from $WG_CONF"
WG_STRIPPED="$(grep -vE '^[[:space:]]*(Address|DNS|MTU|Table|PreUp|PostUp|PreDown|PostDown|SaveConfig)[[:space:]]*=' "$WG_CONF")"
# shellcheck disable=SC2312  # process substitution intentional; wg setconf reads a file path
$IP netns exec "$NS" "$WG" setconf "$WG_IF" <(echo "$WG_STRIPPED")

# Parse the [Interface] Address = ... line manually and apply. The config may
# list multiple comma-separated addresses; assign each.
WG_ADDRS="$(awk -F= '/^[[:space:]]*Address[[:space:]]*=/ {
  gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2
}' "$WG_CONF" | tr ',' '\n')"
if [ -z "${WG_ADDRS:-}" ]; then
  die "no [Interface] Address = ... line found in $WG_CONF"
fi

while IFS= read -r addr; do
  addr="${addr# }"
  addr="${addr% }"
  [ -z "$addr" ] && continue
  # Skip IPv6 addresses — v6 is disabled in the ns.
  case "$addr" in
    *:*) log "skipping IPv6 address on $WG_IF (v6 disabled in ns): $addr" ; continue ;;
  esac
  if $IP -n "$NS" addr show dev "$WG_IF" | grep -qF "inet ${addr%/*}/"; then
    log "$WG_IF already has $addr — skipping"
  else
    log "assigning $addr to $WG_IF"
    $IP -n "$NS" addr add "$addr" dev "$WG_IF"
  fi
done <<EOF
$WG_ADDRS
EOF

log "bringing $WG_IF up"
$IP -n "$NS" link set "$WG_IF" up

# --- Step 8: routing inside the ns ------------------------------------------
# Exception routes are more specific than `default`; kernel prefers longest
# match, so LAN + multicast destinations take the veth, everything else takes
# wg-castcrate.
add_route_if_missing() {
  local prefix="$1"
  local via_or_dev="$2"
  if $IP -n "$NS" route show "$prefix" | grep -q .; then
    log "route already present: $prefix — skipping"
  else
    log "adding route: $prefix $via_or_dev"
    # shellcheck disable=SC2086  # via_or_dev is intentionally multi-word
    $IP -n "$NS" route add "$prefix" $via_or_dev
  fi
}

add_route_if_missing "10.0.0.0/8"      "via $HOST_GW dev $VETH_NS"
add_route_if_missing "172.16.0.0/12"   "via $HOST_GW dev $VETH_NS"
add_route_if_missing "192.168.0.0/16"  "via $HOST_GW dev $VETH_NS"
add_route_if_missing "224.0.0.0/4"     "via $HOST_GW dev $VETH_NS"
add_route_if_missing "default"         "dev $WG_IF"

# --- Step 9: host DNAT rule -------------------------------------------------
# Republishes <LAN_IF>:3000 -> 10.200.200.2:3000 so LAN clients still reach
# the server despite it running inside the ns. Uses conntrack for the reply
# path — no ip_forward toggle needed.
if $IPTABLES -t nat -C PREROUTING -i "$LAN_IF" -p tcp --dport "$DNAT_PORT" \
    -j DNAT --to-destination "$DNAT_TARGET" 2>/dev/null; then
  log "DNAT rule already present on $LAN_IF:$DNAT_PORT — skipping"
else
  log "adding DNAT rule: $LAN_IF:$DNAT_PORT -> $DNAT_TARGET"
  $IPTABLES -t nat -A PREROUTING -i "$LAN_IF" -p tcp --dport "$DNAT_PORT" \
    -j DNAT --to-destination "$DNAT_TARGET"
fi

log "castcrate-ns is up. verify with:"
log "  $IP netns exec $NS curl -s https://ifconfig.co/json  # -> VPN exit IP"
log "  curl -s https://ifconfig.co/json                     # -> host clearnet IP"
