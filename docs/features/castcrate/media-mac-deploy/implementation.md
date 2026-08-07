# Media Mac Deploy — Implementation Plan

**Epic:** castcrate
**Created:** 2026-08-07
**Status:** Planned — physical/runbook feature, no code changes

## Approach

A seven-session linear runbook. Each session is self-contained and pauseable. Total active time ~2½–3 hours. Sessions 1–2 are physical (at the Mac); sessions 3–7 are done over SSH from any laptop on the LAN. Success = the box autostarts CastCrate on boot and reliably casts a real title to the TV.

## Key Decisions

- **Ubuntu Server 26.04 LTS**, not 24.04 (longer support tail; ~4 months of bake-in as of 2026-08). Fall back to 24.04 only if the 26.04 installer misbehaves on this hardware.
- **Linux, not OCLP + macOS.** High Sierra is 8 years EOL, Homebrew dropped it, and even OCLP + Monterey leaves Intel HD 3000 stuck without Metal. Linux runs current Node 22 + ffmpeg from `apt` and has a clean systemd story.
- **NodeSource repo for Node 22** rather than snap/nvm — plays nicely with systemd, matches CastCrate's Node 22+ requirement.
- **pnpm 11.0.8 via corepack** — matches `packageManager` field in root `package.json` so no version drift.
- **Systemd unit runs `node dist/index.js` directly**, not through pnpm — faster start, one fewer layer for systemd to reason about.
- **Direct-cast bias over transcode.** The 2C/4T 2.7 GHz Sandy Bridge box will hit 100 % CPU on any x265 transcode. Configure `TRANSCODE_BITRATE=5M` (default) and rely on YTS x264 releases for the golden path; drop to `3M` if playback stutters.
- **Downloads live on the same SSD** at `/home/castcrate/castcrate-downloads` — no external drive dance needed with 500 GB internal.
- **Naive prune** (`find -mtime +14 -delete`) is enough for v1. If we ever need free-space-aware pruning or lock-file checks, add them then.
- **Firewall locked to LAN CIDR** — CastCrate is single-user LAN-only per mission statement; no remote access story.

## Phases

Each phase maps to one "session" in the walkthrough. See `tasks.md` for the checkbox breakdown.

### Phase 1 — Prep (any working machine, ~30 min)

Back up the Mac, get an 8 GB+ USB stick, download the Ubuntu 26.04 ISO, register an OMDb API key, write the ISO to USB.

### Phase 2 — Install Ubuntu at the Mac (~45–60 min)

Boot the installer holding Option (⌥), run through Ubuntu Server installer with hostname `castcrate`, user `castcrate`, OpenSSH server enabled, LVM off, entire-disk install. Note the DHCP IP; reboot; remove USB.

### Phase 3 — First-boot lockdown over SSH (~20 min)

`apt full-upgrade`, install core packages (`ffmpeg avahi-daemon avahi-utils ufw mbpfan build-essential git curl`), configure `ufw` (LAN-only SSH + :3000; 5353/udp for mDNS), ignore lid switch in `logind.conf`, enable `mbpfan` + `avahi-daemon`, add router DHCP reservation.

### Phase 4 — Node runtime (~15 min)

Node 22 via NodeSource, pnpm 11.0.8 via corepack. Fallback: if NodeSource has no 26.04 codename yet, use the `noble` (24.04) repo entry — Node binaries don't care.

### Phase 5 — Deploy CastCrate (~30 min)

`git clone` into `~/castcrate`, `pnpm install`, `pnpm --filter @castcrate/server build`, `pnpm --filter @castcrate/web build`, `mkdir ~/castcrate-downloads`, copy `.env.example` → `apps/server/.env`, set `OMDB_API_KEY`, `PORT=3000`, `DOWNLOAD_PATH=/home/castcrate/castcrate-downloads`. One-time manual `pnpm start` to verify the UI loads from another machine on the LAN before turning it into a service.

### Phase 6 — Autostart via systemd (~20 min)

Write `/etc/systemd/system/castcrate.service` (Type=simple, `ExecStart=/usr/bin/node .../dist/index.js`, `EnvironmentFile=.env`, `Restart=on-failure`, hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths` scoped to the download dir). `systemctl enable --now castcrate`. Run the end-to-end cast test with a real title. Reboot to prove it comes back clean.

### Phase 7 — Retention timer (~10 min)

Install `/etc/systemd/system/castcrate-prune.service` (oneshot; `find -mtime +14 -print -delete`) plus `castcrate-prune.timer` (`OnCalendar=*-*-* 04:00:00`, `RandomizedDelaySec=15min`, `Persistent=true`). Verify with `systemctl list-timers`.

## Files Affected

None in the repo. This feature adds only its own docs (`docs/features/castcrate/media-mac-deploy/{requirements,implementation,tasks,context}.md`). All build artefacts (systemd units, `.env`, download dir) live on the target machine, not in git.

## Definition of Done

**Functional**
- Cold boot → SSH answers on `castcrate@castcrate.local` within 60 s of the login prompt appearing.
- `systemctl is-active castcrate` returns `active` without a manual start after a fresh boot.
- `http://castcrate.local:3000` serves the CastCrate UI from any device on the LAN.
- A search for a well-seeded title returns at least one magnet from an enabled indexer.
- A full end-to-end cast (search → pick release → cast → playback on the TV) succeeds using a real Chromecast on the LAN.

**Quality**
- `ufw status` shows the three intended rules (SSH LAN-only, :3000 LAN-only, 5353/udp) and default-deny inbound.
- `systemctl status castcrate castcrate-prune.timer avahi-daemon mbpfan` all report `active`.
- Lid-closed operation confirmed (close the lid, wait 30 s, cast still works).
- `journalctl -u castcrate --since "1 hour ago" | grep -iE "error|warn"` returns nothing alarming after a full cast session.

**Integration**
- Router shows the DHCP reservation and the box is always at the reserved IP after a lease renewal.
- `avahi-browse -art | grep -i cast` from the Ubuntu host lists at least one Chromecast (mDNS reachable).
- Retention timer next-run date visible in `systemctl list-timers castcrate-prune.timer`.

## Quality Bar

- **Reliability over cleverness.** Runbook fidelity matters more than elegance — every step verifiable, every checkpoint concrete.
- **Locked-down by default.** UFW default-deny, LAN-CIDR-scoped rules, no snap/Docker/telemetry, no ports exposed beyond what CastCrate needs.
- **Self-healing.** systemd restarts on crash; prune timer catches up (`Persistent=true`) if the box was off at 04:00.
- **Diagnosable.** Every failure mode in the walkthrough has a `journalctl` or `systemctl` line that reveals the cause in one command.
