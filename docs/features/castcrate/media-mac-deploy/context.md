# media-mac-deploy — Context

**Last updated:** 2026-08-07

Running notes / decisions / surprises from executing the runbook. Grow this as things happen; each session, drop a short entry with what was done, what deviated from the plan, and any config that had to be tuned.

## Session log

### 2026-08-07 — Phase 1 started

- Runbook feature scaffolded, committed (`4d04ad0`), pushed.
- Phase 1 kicked off; nothing physical done yet.

### 2026-08-07 — Phase 1 complete ✅

- Ubuntu 26.04 ISO written to a 64 GB USB stick (`/dev/rdisk5`) — clean, 2.9 GB in 89 s. Previous macOS Sonoma installer on the stick sacrificed.
- OMDb API key registered + activated (saved off-repo).
- `sudo` on user's Mac does not do tilde expansion (probably a shell alias) — had to use absolute path for `dd`. Noted for future runbooks.

### 2026-08-07 — Network topology confirmed

- Starlink + TP-Link Deco mesh network. Gateway is **192.168.1.1**.
- Managed via the Deco mobile app (no useful web UI at 192.168.1.1).
- **Open question for Phase 3:** is the Deco in **Router mode** (→ DHCP reservation via Deco app: More → Advanced → IP Reservation) or **Access Point mode** (→ Starlink app doesn't expose IP reservation; fall back to a **static IP configured on Ubuntu via netplan** in P3.7)? Check Deco app → More → Operation Mode at P3.7.

### 2026-08-07 — Phase 2 (first attempt, scrapped)

- Ubuntu Server 26.04 installed cleanly on the 500 GB SSD via the USB installer. No boot quirks.
- Hostname `castcrate`, user `castcrate`, entire-disk install, LVM off, OpenSSH server on, no snaps.
- First-boot ethernet DHCP: **192.168.1.53**.
- **Password forgotten before first SSH.** GRUB → recovery mode not reachable (Mac EFI + Shift-key timing). Chose to reinstall rather than chroot-passwd — no sunk cost, cleaner slate.

### 2026-08-07 — Reinstall in progress

- Reinstalling from the same USB. Same defaults. **Password written down this time.**

### 2026-08-08 — Phase 2 complete ✅ (second attempt)

- Reinstall clean, console login verified, password saved.
- **Temp IP: 192.168.1.249** (box is on a temporary ethernet port for setup; will move to final port after Phase 6). No cast happening yet → moving IP is harmless.
- **P3.7 plan:** wait until box is on its permanent port, note the IP the Deco assigns there, then either add a Deco IP Reservation (if Deco is in Router mode) or set a static IP on Ubuntu via netplan (if Deco is in AP mode). LAN CIDR `192.168.1.0/24` is stable either way, so the ufw rules in P3.4 don't need to change.

### 2026-08-08 — Phase 3 started

- SSH working from main laptop to `castcrate@192.168.1.249` on password auth. (Public-key auth via GitHub import didn't line up on first try; enabled `PasswordAuthentication yes` at the console.)
- Ethernet interface name: **`enp2s0f0`**.
- Idle temp: 55 °C (fanless — will move under mbpfan control in P3.6).
- **⚠️ Disk sizing check needed**: root partition reports **~98 GB** ("Usage of /: 7.4% of 97.87GB") on a 500 GB SSD. Either the SSD is smaller than expected or the installer left space unallocated. Investigate with `lsblk` after Phase 3; grow the partition if unallocated. Not blocking.
- **RESOLVED (2026-08-08):** Ubuntu 26.04 installer used LVM despite "uncheck LVM" instruction. Layout was `sda3` (444 GB PV) with only 100 GB allocated to `ubuntu-vg/ubuntu-lv`. Live-extended with `lvextend -l +100%FREE` + `resize2fs` — root now **437 GB (410 GB free)**, zero downtime. Future runbooks should either confirm the LVM checkbox is actually off, or plan on this LV-extend step as part of Phase 3.

### 2026-08-08 — Phase 3 done ✅ (except deferred 3.7 DHCP)

- System fully updated (`apt full-upgrade`, 40 updates applied). All core packages installed: build-essential, git, curl, ffmpeg, avahi-daemon, avahi-utils, ufw, mbpfan.
- **ufw** active with LAN-only (192.168.1.0/24) rules for SSH + :3000, and 5353/udp for mDNS (auto v4+v6).
- **Lid switch** ignored in `logind.conf`; `systemd-logind` restarted.
- **mbpfan** + **avahi-daemon** enabled + running.
- Reboot test passed — all services autostarted, SSH reconnected on the first try.
- Idle temp post-reboot 69 °C (mbpfan not yet under load); will re-check after real workload.
- **Root filesystem extended** from 100 GB → 437 GB (410 GB free) via `lvextend -l +100%FREE` + `resize2fs`.
- **DHCP reservation (3.7) deferred** until box moves to its permanent ethernet port.
- **SSH auth:** password auth is on (was needed after the GitHub key import mismatch on the second install). Consider adding the main-laptop pubkey to `~/.ssh/authorized_keys` on the box later so we can turn password auth off.

### Template



### 2026-MM-DD — Phase X: <summary>

- What was done: <bullet list>
- Deviations from `tasks.md`: <e.g. NodeSource had no 26.04 codename, used noble repo>
- Values chosen: <e.g. LAN CIDR = 192.168.1.0/24, IP reservation = .42>
- Errors / follow-ups: <e.g. mDNS not reaching Chromecast until router IGMP-snooping disabled>

---

## Key values (fill in as you go)

- **LAN IP (reserved):** `192.168.1.249` (TEMP DHCP lease on a temporary ethernet port; pin the *final* IP in P3.7 after the box moves to its permanent port)
- **LAN CIDR (used in ufw rules):** `192.168.1.0/24` (gateway 192.168.1.1, Starlink + Deco mesh)
- **Hostname:** `castcrate` (`.local` via avahi)
- **User:** `castcrate`
- **Download path:** `/home/castcrate/castcrate-downloads`
- **OMDb key location:** `apps/server/.env` on the box (never committed)
- **Chromecast device name(s):** _tbd_

## Known gotchas we've hit

_(none yet — populate as we hit them)_
