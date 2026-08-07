# Media Mac Deploy — Requirements

**Epic:** castcrate
**Created:** 2026-08-07

## Overview

Turn a dedicated Early-2011 MacBook Pro 13" (i7 2.7 GHz, 16 GB RAM, HD Graphics 3000, 500 GB SATA SSD) into a permanent CastCrate media server, running Ubuntu Server 26.04 LTS over ethernet and casting to Chromecast devices on the LAN. This is a one-off runbook feature — physical hardware, physical steps — not shipping code. Success = the box lives on a shelf, autostarts CastCrate on boot, and reliably casts to the TV without human intervention.

## Requirements

- Wipe macOS High Sierra and install Ubuntu Server 26.04 LTS on the 500 GB SSD.
- Headless from day one: SSH access from the main laptop, no monitor/keyboard needed after install.
- CastCrate runs as a `systemd` service, autostarts on boot, restarts on crash, reachable at `http://castcrate.local:3000` on the LAN.
- Chromecast discovery works from the Ubuntu host (mDNS via `avahi-daemon` + `bonjour-service` npm module on UDP `224.0.0.251:5353`).
- Firewall (`ufw`) locked to LAN CIDR for SSH + CastCrate HTTP; mDNS open on 5353/udp.
- Lid-close ignored so the laptop keeps running with the lid shut.
- Fan control via `mbpfan` (2011 MBPs run silent under Linux and thermally throttle otherwise).
- Router DHCP reservation on the box's MAC so its LAN IP is stable (Chromecasts fetch stream by IP).
- Nightly `systemd` timer prunes `DOWNLOAD_PATH` of files older than 14 days so the SSD doesn't fill up.
- One end-to-end cast test with a real title passes before we call this done.

## Dependencies

- **Hardware:** the 2011 MBP with the SSD installed, ethernet cable, USB stick (8 GB+), Chromecast on the LAN, router admin access for DHCP reservation.
- **External services:** OMDb API key (free tier), Ubuntu 26.04 ISO, NodeSource repo for Node 22.
- **Repo:** `castcrate` at its current `main` (Fastify server + Vite web build + `.env.example`).
- **No other features block this** — it deploys the epic's existing code as-is.

## Out of Scope

- Splitting the umbrella castcrate epic into thematic sub-epics (do later via `/create-epic` if it grows unwieldy).
- Any remote-access story (VPN, tunneling, WAN reachability) — CastCrate is LAN-only by design.
- Auth / multi-user — single-user home box.
- OpenCore Legacy Patcher + macOS deployment path (documented in the earlier chat but explicitly rejected in favour of Ubuntu).
- Free-space-aware pruning, `lsof`-guarded prunes, or fancier retention (v2 if the naive `-mtime +14` misbehaves).
- Automated backups of `~/.castcrate/history.json` — recents list, not precious.

---

*Consumed by `/plan-feature castcrate/media-mac-deploy` (already planned inline — see `implementation.md`).*
