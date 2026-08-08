# media-mac-deploy — Tasks

**Last updated:** 2026-08-07
**Progress:** 29/47 — Phase 5 in progress (5.1–5.7 ✅ ; manual test passed, 3 player UX bugs logged against player-buffer-ux for later)

Runbook feature. Tasks correspond 1:1 to the "sessions" in the walkthrough. Tick items as you complete them; update the "Last updated" date each session and ping me with what you did (and any surprises) so I can help debug.

---

## Phase 1 — Prep (any working machine, ~30 min)

- [x] **1.1** Back up the Mac (Time Machine or manual copy of anything precious).
- [x] **1.2** Locate a spare 8 GB+ USB stick (will be wiped).
- [x] **1.3** Download Ubuntu 26.04 LTS Server ISO from `https://releases.ubuntu.com/26.04/` (`ubuntu-26.04-live-server-amd64.iso`).
- [x] **1.4** Register OMDb API key at `https://www.omdbapi.com/apikey.aspx`; click the activation link in the confirmation email; save the key.
- [x] **1.5** Write the ISO to USB (`dd` on macOS or balenaEtcher).
- [x] **1.6** Note the router admin URL + credentials — needed for the DHCP reservation in Phase 3.

**Acceptance:** USB installer ready, OMDb key saved, Mac backup complete. ✅ (2026-08-07)

---

## Phase 2 — Install Ubuntu at the Mac (~45–60 min)

- [x] **2.1** Plug Mac into ethernet + power. Insert the USB installer.
- [x] **2.2** Power on holding Option (⌥); pick the orange "EFI Boot" entry.
- [x] **2.3** Run the installer — accept defaults except: keyboard = English (Macintosh), hostname = `castcrate`, username = `castcrate`, entire-disk install with LVM OFF.
- [x] **2.4** Enable OpenSSH server; paste an SSH public key if you have one.
- [x] **2.5** Skip Ubuntu Pro and all featured snaps.
- [x] **2.6** Wait for install to complete (10–20 min); reboot; pull the USB out.
- [x] **2.7** Log in at the physical console; note the ethernet IPv4 address printed above the prompt.

**Acceptance:** local console login as `castcrate` works; LAN IP is known. ✅ (2026-08-08, temp IP = 192.168.1.249; final IP pinned at P3.7 after box moves to permanent port)

---

## Phase 3 — First-boot lockdown over SSH (~20 min)

- [x] **3.1** From your laptop: `ssh castcrate@<ip>` (or `castcrate@castcrate.local` once avahi is running); accept the host key.
- [x] **3.2** `sudo apt update && sudo apt full-upgrade -y`.
- [x] **3.3** `sudo apt install -y build-essential git curl ca-certificates ffmpeg avahi-daemon avahi-utils ufw mbpfan`.
- [x] **3.4** Configure `ufw`: default deny in / allow out; allow SSH + :3000 from LAN CIDR only (adjust CIDR to your LAN); allow 5353/udp for mDNS; `sudo ufw --force enable`.
- [x] **3.5** Ignore lid switch in `/etc/systemd/logind.conf` (`HandleLidSwitch=ignore`, `HandleLidSwitchExternalPower=ignore`); `sudo systemctl restart systemd-logind`.
- [x] **3.6** `sudo systemctl enable --now mbpfan avahi-daemon`.
- [ ] **3.7** Log into the router; add a DHCP static reservation for the Mac's MAC → current IP. **(DEFERRED — waiting for box to move to its permanent ethernet port; will pin the *final* IP not the temp `.249`.)**
- [x] **3.8** Reboot; confirm SSH still works and lid-closed operation doesn't kill it (close lid, wait 30 s, `ssh` still answers). **(reboot survived + all services active; lid-close subtest deferred to when box moves to permanent location)**

**Acceptance:** SSH via `castcrate.local` works, `ufw status` shows three rules, `systemctl status mbpfan avahi-daemon` both active, DHCP reservation in place.

---

## Phase 4 — Node runtime (~15 min)

- [x] **4.1** Install Node 22 via NodeSource: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`.
- [x] **4.2** If NodeSource complains about 26.04/plucky, edit `/etc/apt/sources.list.d/nodesource.list` and change the codename to `noble`; re-run `sudo apt install -y nodejs`. **(N/A — NodeSource uses `nodistro/main`, no codename issue)**
- [x] **4.3** Enable corepack + pin pnpm: `sudo corepack enable && corepack prepare pnpm@11.0.8 --activate`.
- [x] **4.4** Sanity check: `node -v` (v22.x), `pnpm -v` (11.0.8), `ffmpeg -version`.

**Acceptance:** all three version commands print clean output. ✅ (2026-08-08 — v22.23.2 / 11.0.8 / ffmpeg 8.0.1)

---

## Phase 5 — Deploy CastCrate (~30 min)

- [x] **5.1** `cd ~ && git clone https://github.com/DJStarmallama/castcrate.git && cd castcrate`. **(repo made public to skip PAT/SSH auth)**
- [x] **5.2** `pnpm install` (pulls webtorrent, castv2-client, etc.).
- [x] **5.3** `pnpm --filter @castcrate/server build` (TS → dist/).
- [x] **5.4** `pnpm --filter @castcrate/web build` (Vite prod bundle).
- [x] **5.5** `mkdir -p ~/castcrate-downloads`.
- [x] **5.6** `cp .env.example apps/server/.env`, then edit and set: `OMDB_API_KEY`, `PORT=3000`, `DOWNLOAD_PATH=/home/castcrate/castcrate-downloads`, keep `BUFFER_PERCENT=2` / `TRANSCODE_BUFFER_PERCENT=5` / `TRANSCODE_BITRATE=5M`.
- [x] **5.7** Manual test: `pnpm --filter @castcrate/server start`; from your laptop open `http://castcrate.local:3000`; verify the UI loads and OMDb search returns results. **✅ Matrix played end-to-end; 3 player UX bugs (buffer-bar-won't-dismiss, cast button hidden, captions button hidden — z-index/stacking) logged to `player-buffer-ux/context.md`, deferred until after Phase 7.**
- [ ] **5.8** `Ctrl+C` to stop the manual server.

**Acceptance:** UI loads on another LAN device; OMDb search returns metadata; at least one torrent source returns a magnet for a well-seeded title. ✅ (2026-08-08)

---

## Phase 6 — Autostart via systemd (~20 min)

- [ ] **6.1** Create `/etc/systemd/system/castcrate.service` with `ExecStart=/usr/bin/node /home/castcrate/castcrate/apps/server/dist/index.js`, `EnvironmentFile=/home/castcrate/castcrate/apps/server/.env`, `User=castcrate`, `Restart=on-failure`, hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=/home/castcrate/castcrate-downloads`).
- [ ] **6.2** `sudo systemctl daemon-reload && sudo systemctl enable --now castcrate`.
- [ ] **6.3** `systemctl status castcrate` shows `active (running)`; `journalctl -u castcrate -n 50` looks clean.
- [ ] **6.4** End-to-end cast test: from a phone/laptop → `http://castcrate.local:3000` → search a real title → pick a release → cast to the Chromecast → playback starts on the TV.
- [ ] **6.5** Reboot the box (`sudo reboot`); wait 1 min; SSH back in; `systemctl status castcrate` is already `active` without any manual start.
- [ ] **6.6** Repeat the cast test once more after the reboot to prove it's reproducible.

**Acceptance:** cold boot → cast works without human intervention.

---

## Phase 7 — Retention timer (~10 min)

- [ ] **7.1** Create `/etc/systemd/system/castcrate-prune.service` (oneshot; `find ~/castcrate-downloads -type f -mtime +14 -print -delete` + empty-dir sweep; hardening as per implementation.md).
- [ ] **7.2** Create `/etc/systemd/system/castcrate-prune.timer` (`OnCalendar=*-*-* 04:00:00`, `RandomizedDelaySec=15min`, `Persistent=true`).
- [ ] **7.3** `sudo systemctl daemon-reload && sudo systemctl enable --now castcrate-prune.timer`.
- [ ] **7.4** `systemctl list-timers castcrate-prune.timer` shows the next 04:00 run.
- [ ] **7.5** Dry-run today: `sudo -u castcrate find ~/castcrate-downloads -type f -mtime +14 -print` — should print nothing yet (fresh install).

**Acceptance:** timer scheduled; service unit passes a manual `sudo systemctl start castcrate-prune.service` without error.

---

## Sign-off

- [ ] **DoD.** All Definition-of-Done items in `implementation.md` verified. Feature moved to Complete; epic-overview + master overview refreshed via `/update-epic castcrate` + `/update-master`.

---

## Notes for updating me

When you finish a phase (or hit something weird), just say something like:
- "done through 3.6, mbpfan is running fine"
- "stuck on 5.7 — UI loads but OMDb returns 401"
- "everything green through Phase 4"

I'll tick the boxes here, help debug anything that misfires, and keep `context.md` in sync with any decisions we take mid-flight.
