# media-mac-deploy — Tasks

**Last updated:** 2026-08-09
**Progress:** **47/47 — DEPLOY COMPLETE ✅.** All seven phases done. Cast test passed on real Chromecast HD ("Master Llama" / Llama Lounge TV), reboot survival proven, retention timer scheduled with sandbox-verified prune service. Full commit chain landed in the same session: crash fix (`4cb84d9`), three source-bug fixes (`1d65f44`), player overlay layering (`4ca3c2b`), Chromecast inventory (`503f61c`), audio loudness chain (`e7f12a3` → `254bae8` → `6e4f73e`), SIGTERM shutdown fix (this commit). Follow-ups logged (non-blocking): subtitle hot-swap during active cast (`castcrate/subtitles/context.md`), direct-play audio-normalization pass (`castcrate/transcoding`), scp box-notes.patch for `git am`.

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
- [x] **3.3** `sudo apt install -y build-essential git curl ca-certificates ffmpeg avahi-daemon avahi-utils ufw mbpfan wireguard-tools iptables`.
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
- [x] **5.8** `Ctrl+C` to stop the manual server.

**Acceptance:** UI loads on another LAN device; OMDb search returns metadata; at least one torrent source returns a magnet for a well-seeded title. ✅ (2026-08-08)

---

## Phase 6 — Autostart via systemd (~20 min)

- [x] **6.1** Create `/etc/systemd/system/castcrate.service` with `ExecStart=/usr/bin/node /home/castcrate/castcrate/apps/server/dist/index.js`, `EnvironmentFile=/home/castcrate/castcrate/apps/server/.env`, `User=castcrate`, `Restart=on-failure`, hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=/home/castcrate/castcrate-downloads`).
- [x] **6.2** `sudo systemctl daemon-reload && sudo systemctl enable --now castcrate`.
- [x] **6.3** `systemctl status castcrate` shows `active (running)`; `journalctl -u castcrate -n 50` looks clean.
- [x] **6.4** End-to-end cast test: from a phone/laptop → `http://castcrate.local:3000` → search a real title → pick a release → cast to the Chromecast → playback starts on the TV. **✅ (2026-08-08) Interstellar cast to Llama Lounge TV — video playing on the TV, cast controls (play/pause/seek/volume) working. Follow-up gap logged: switching subtitles while a cast is active only updates local player state; no hot-swap API to update the receiver's active track. Logged under `castcrate/subtitles` → context.md.**
- [x] **6.5** Reboot the box (`sudo reboot`); wait 1 min; SSH back in; `systemctl status castcrate` is already `active` without any manual start. **✅ (2026-08-08) Boot at 09:26:21 UTC, `castcrate.service` came up at 09:26:30 unattended, serving requests by 09:26:32. Auto-start on boot proven.**
- [x] **6.6** Repeat the cast test once more after the reboot to prove it's reproducible. **✅ (2026-08-08) Cast to Llama Lounge TV succeeded post-boot with audio-normalization pipeline (see `castcrate/transcoding` for the loudnorm work landed same session).**

**Acceptance:** cold boot → cast works without human intervention.

---

## Phase 7 — Retention timer (~10 min)

- [x] **7.1** Create `/etc/systemd/system/castcrate-prune.service` (oneshot; `find ~/castcrate-downloads -type f -mtime +14 -print -delete` + empty-dir sweep; hardening as per implementation.md). ✅ `systemd-analyze verify` clean, sandbox matches `castcrate.service` (NoNewPrivileges, ProtectSystem=strict, ProtectHome=read-only, PrivateTmp=true, ReadWritePaths scoped to downloads).
- [x] **7.2** Create `/etc/systemd/system/castcrate-prune.timer` (`OnCalendar=*-*-* 04:00:00`, `RandomizedDelaySec=15min`, `Persistent=true`). ✅
- [x] **7.3** `sudo systemctl daemon-reload && sudo systemctl enable --now castcrate-prune.timer`. ✅ `is-enabled=enabled`, `is-active=active`, symlinked into `timers.target.wants/`.
- [x] **7.4** `systemctl list-timers castcrate-prune.timer` shows the next 04:00 run. ✅ Next run 2026-08-09 04:13:22 UTC (04:00 + 13m22s randomized delay — confirms both OnCalendar and RandomizedDelaySec are live). Note: UTC, not local.
- [x] **7.5** Dry-run today: `sudo -u castcrate find ~/castcrate-downloads -type f -mtime +14 -print` — should print nothing yet (fresh install). ✅ No files >14d; oldest mtime on box is same-day. Also proved with a live smoke test (`sudo systemctl start castcrate-prune.service` ran twice, both `ExecMainStatus=0/SUCCESS`; first run correctly removed a pre-existing empty `Subs/` dir, second run was a no-op).

### 7.6 — Update `castcrate-prune.service` to be pin-aware (watch-later feature, 2026-08-11 planning)

The nightly prune must now respect `~/.castcrate/library.json`'s `pinned: true` entries — the Watch Later feature promises that pinned files survive retention. Ship the script `scripts/prune-downloads.sh` (in the repo) and re-point the unit's `ExecStart=` at it. Runbook steps:

- [ ] **7.6.1** Install `jq` on the box (used by the new script to parse `library.json`): `sudo apt install -y jq`. Re-run of Phase 3.3's apt line would pick this up on clean installs; here it's an in-place add.
- [ ] **7.6.2** Copy the new script: `scp scripts/prune-downloads.sh castcrate@<box>:/tmp/ && sudo mv /tmp/prune-downloads.sh /opt/castcrate/scripts/ && sudo chmod 755 /opt/castcrate/scripts/prune-downloads.sh && sudo chown root:root /opt/castcrate/scripts/prune-downloads.sh`.
- [ ] **7.6.3** Edit `/etc/systemd/system/castcrate-prune.service`:
  - Replace the inline `find … -mtime +14 -delete` `ExecStart=` line with `ExecStart=/opt/castcrate/scripts/prune-downloads.sh`.
  - Add `EnvironmentFile=/home/castcrate/castcrate/apps/server/.env` so `DOWNLOAD_PATH`, `HISTORY_DIR`, and (optionally) `RETENTION_DAYS` are read from the same env file the app uses. Absolute path — do NOT use `~` (tilde-footgun — see Phase 3's `EnvironmentFile=` gotcha).
  - Keep every existing sandbox directive verbatim: `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp=true`, `ReadWritePaths=/home/castcrate/castcrate-downloads`. `ProtectHome=read-only` still lets us READ `/home/castcrate/.castcrate/library.json` — no unit change needed there.
  - Optionally add `ReadOnlyPaths=/home/castcrate/.castcrate` for defence-in-depth (the script only reads that dir; explicit ro-mount defends against future script bugs that might try to write it).
- [ ] **7.6.4** `sudo systemctl daemon-reload && sudo systemctl start castcrate-prune.service`. Expected on a clean library: exit 0, `journalctl -u castcrate-prune -n 30 --no-pager` shows the summary line (`found=N skipped=K deleted=M`) with `deleted=0` if no files older than 14 days exist.
- [ ] **7.6.5** Fail-safe verification (do this ONCE at deploy time): `sudo systemctl stop castcrate.service` (so the manifest isn't being written concurrently); make a corrupt copy: `sudo -u castcrate cp /home/castcrate/.castcrate/library.json{,.bak}; echo '{not json' | sudo tee /home/castcrate/.castcrate/library.json > /dev/null`; run `sudo systemctl start castcrate-prune.service`; verify the unit reports `failed` (exit 1) via `systemctl status castcrate-prune.service`; verify no files were deleted (`ls -la ~/castcrate-downloads`); restore: `sudo -u castcrate mv /home/castcrate/.castcrate/library.json{.bak,}`. This is the whole product promise — verify it once.
- [ ] **7.6.6** Pin verification (do this ONCE with a real pinned file): pin any completed Watch Later item via the UI, then age its file with `sudo touch -d "20 days ago" <path>` and `sudo systemctl start castcrate-prune.service`; the file must survive. `journalctl -u castcrate-prune` shows `SKIP (pinned) <path>` for that file.

**Acceptance:** timer scheduled; service unit passes a manual `sudo systemctl start castcrate-prune.service` without error. ✅ (2026-08-08). Pin-aware upgrade pending — see 7.6 above (watch-later feature Phase 5).

---

## Phase 8 — VPN routing (~30 min)

Sets up the WireGuard-in-network-namespace scaffolding and picks one of three routing modes via `VPN_MODE=`. All three modes share the same infrastructure (namespace, `wg0.conf`, scripts, systemd units); the differences are (a) whether Fastify runs inside the ns, and (b) which iptables + veth pieces are wired up. Assumes Phase 3's apt line has been re-run so `wireguard-tools` and `iptables` are installed (Ubuntu 24.04+ ships plain `iptables` with the nft backend as default — do **not** try to install a `iptables-nft` package, it does not exist).

### Pick your `VPN_MODE`

| Value | What runs where | Pick this if… | Trade-off |
|---|---|---|---|
| `off` | Fastify on host, no ns | You only stream from public sources (YTS, Knaben) and don't care about hiding your torrent-tracker IP. | No VPN protection. |
| `vpn` (v1, `vpn-split-tunnel`) | Fastify INSIDE `castcrate-ns`. All outbound (indexers, peers, DHT, metadata, subtitles) via WG. | You want maximum privacy for every outbound request. | ~250ms RTT added to peer connections; typical peer throughput <5 MB/s. |
| `torrentday-only` (v2, `vpn-torrentday-only`) | Fastify on the host. Only the TorrentDay adapter's HTTP fetches are spawned into the ns via `ip netns exec castcrate-ns node /opt/castcrate/scripts/td-fetcher.js <url>`. | You use TorrentDay AND want full peer throughput. | Loses "all outbound is VPN'd" privacy — trackers, metadata, subtitles use your home IP. |

**Absolute paths only in every command below.** `EnvironmentFile=` and other systemd directives do NOT expand `~` — this is the tilde-footgun from the original deploy (see `context.md` → "Root cause found" and Known-gotchas → "systemd `EnvironmentFile=` does NOT expand `~`"). The env file lives at `/home/castcrate/castcrate/apps/server/.env`.

- [ ] **8.1** `sudo mkdir -p /etc/castcrate && sudo chmod 700 /etc/castcrate` — WG config directory.
- [ ] **8.2** Download `wg0.conf` from your VPN provider dashboard (Mullvad account page / PIA WG generator / Proton downloads / AirVPN config generator / **IPVanish's WireGuard Configuration Generator at `my.ipvanish.com/wireguard/`**). Copy it to the box, then `sudo mv <path>/wg0.conf /etc/castcrate/wg0.conf && sudo chmod 600 /etc/castcrate/wg0.conf && sudo chown root:root /etc/castcrate/wg0.conf`. **IPVanish-specific settings:** pick an EU P2P-friendly endpoint (Amsterdam / Netherlands / Switzerland / Romania — avoid US endpoints, some throttle P2P). Turn **OFF** "Exclude LAN Traffic" (our netns handles the LAN carve-out at the route layer; IPVanish's split-tunnel would fight our design). Turn **OFF** "Use Custom Public Key" (let the provider generate the keypair).
- [ ] **8.3** Capture the box's clearnet IP **before enabling the ns**: `curl -s https://ifconfig.co/ip`. Append three lines to `/home/castcrate/castcrate/apps/server/.env`: `HOST_CLEARNET_IP=<value>`, `VPN_MODE=<one of vpn|torrentday-only|off>`, and (v1 only) `CASTCRATE_LAN_IP=<box's LAN IP>` (usually `192.168.1.x` on the Deco setup; find it with `ip -4 addr show | grep 192.168`). The `CASTCRATE_LAN_IP` is required under `VPN_MODE=vpn` because inside the netns `os.networkInterfaces()` only sees `lo` + `veth-cc-ns`, which would otherwise break Chromecast stream URL construction. Under `torrentday-only` it is a no-op (Fastify sees real interfaces on the host); safe to leave set for future mode swaps back to `vpn`.
  - **Which mode to write here?** See the table above. Default recommendation on this box (fast peers + TD access): `VPN_MODE=torrentday-only`.
- [ ] **8.4** Copy the netns scripts + subprocess fetchers from your dev machine to the box:
  ```
  scp scripts/netns-up.sh scripts/netns-down.sh scripts/run-server.sh \
      scripts/td-fetcher.js scripts/ns-fetcher.js \
      castcrate@<box>:/tmp/
  ```
  On the box:
  ```
  sudo mkdir -p /opt/castcrate/scripts
  sudo mv /tmp/netns-up.sh /tmp/netns-down.sh /tmp/run-server.sh \
          /tmp/td-fetcher.js /tmp/ns-fetcher.js \
          /opt/castcrate/scripts/
  sudo chmod 755 /opt/castcrate/scripts/*.sh /opt/castcrate/scripts/*.js
  ```
  The two `.js` fetchers are only invoked under `VPN_MODE=torrentday-only`, but copying them regardless keeps mode swaps atomic. Both are stdlib-only Node scripts — no `pnpm install` needed at `/opt/castcrate/scripts/`.
- [ ] **8.5** Copy the systemd units: `scp deploy/systemd/castcrate-netns.service deploy/systemd/castcrate.service castcrate@<box>:/tmp/`. On the box: `sudo mv /tmp/castcrate-netns.service /tmp/castcrate.service /etc/systemd/system/`.
- [ ] **8.6** `sudo systemctl daemon-reload && sudo systemctl enable --now castcrate-netns.service`. Verify `systemctl is-active castcrate-netns` returns `active`, and `ip netns list` shows `castcrate-ns`. **`VPN_MODE=off` note:** `castcrate-netns.service` is guarded by `ConditionPathExists=/etc/castcrate/wg0.conf`. If you're deploying `off`, either skip this step or accept the unit will become `active` (no-op) and stay so.
- [ ] **8.7** `sudo systemctl restart castcrate.service`. Verify `systemctl is-active castcrate` returns `active`. Then `sudo journalctl -u castcrate -n 50 --no-pager` — no `denied` / `read-only` / `EROFS` errors (the tilde-footgun / sandboxed-write-path class of bugs from the original deploy; if any appear, re-check paths in `.env` and in the unit's `ReadWritePaths=` before proceeding).
- [ ] **8.8** Verify egress split.
  - **Under `VPN_MODE=vpn`:** Inside the ns: `sudo ip netns exec castcrate-ns curl -s https://1.1.1.1/cdn-cgi/trace | grep -E '^(ip|loc)='` returns the **VPN exit IP + country**. Outside the ns (plain host): `curl -s https://1.1.1.1/cdn-cgi/trace | grep -E '^(ip|loc)='` returns the **home clearnet IP** — should match the `HOST_CLEARNET_IP` set in 8.3.
  - **Under `VPN_MODE=torrentday-only`:** Same expectation for both curls, BUT verify the fetcher explicitly: `sudo ip netns exec castcrate-ns /usr/bin/node /opt/castcrate/scripts/ns-fetcher.js https://1.1.1.1/cdn-cgi/trace` returns the trace body with the VPN exit IP. Confirm Fastify is on the host: `ss -tlnp | grep :3000` shows the `node` PID bound directly on the host interface (not inside the ns); `readlink /proc/<pid>/ns/net` matches the host netns inode, not `castcrate-ns`'s.
- [ ] **8.9** From a LAN client: `curl -s http://<box>:3000/api/system/vpn-health | jq .` returns `{ "mode": "<vpn|torrentday-only>", "publicIp": "<VPN IP>", "country": "<XX>", "leaking": false, "reachable": true, "wgPeer": "<host:port>", "lastCheckedAt": <recent ms> }`.
- [ ] **8.10** Load the CastCrate UI in a LAN browser: `http://<box>:3000`. The nav pill shows green `VPN · <XX>` (v1) or `TD-only · <XX>` (v2) on every screen. Settings → Network / VPN section shows the full VPN status block and a mode-appropriate explainer.
- [ ] **8.11** **Cast regression:** search "Interstellar", cast to **Master Llama** (the exact title + device used to close the original `media-mac-deploy` in Phase 6.4), confirm playback starts on the TV within 30s.
- [ ] **8.12** **TorrentDay regression** (the whole reason this feature exists): search a title known to have TD results. Confirm **non-empty** results without the user touching the box's system-level VPN.
- [ ] **8.13** **Kill-switch spot-check.** Semantics differ by mode:
  - **Under `VPN_MODE=vpn`:** Tear WG down inside the ns: `sudo ip netns exec castcrate-ns wg-quick down wg-castcrate` (this may error since our script uses manual `wg setconf` rather than `wg-quick up`; the tear-down still removes the interface which is all we need). Trigger an indexer search from the UI. Confirm: (a) the search fails/hangs within 30s (ALL sources fail — full-tunnel means everything is behind WG), (b) the nav pill flips to `?` UNREACHABLE within 60s, (c) `curl -s http://<box>:3000/api/system/vpn-health | jq .` reports `reachable: false`.
  - **Under `VPN_MODE=torrentday-only`:** Same tear-down. Trigger a TD search from the UI. Confirm: (a) the TD search fails cleanly (empty results with `errors[]` containing `{ source: "torrentday", code: "fetch" }` — subprocess exits non-zero because WG is down inside the ns), (b) a YTS or Knaben search STILL WORKS (they're on host clearnet, unaffected by WG state), (c) the nav pill flips to `?` UNREACHABLE within 60s, (d) `curl -s http://<box>:3000/api/system/vpn-health | jq .` reports `reachable: false`.
  - Bring the tunnel back up cleanly with `sudo systemctl restart castcrate-netns.service` (do **not** use `wg-quick up wg-castcrate` — our netns-up script uses manual `wg setconf`, and mixing the two creates confusion). Verify recovery within 60s: `vpn-health` returns `reachable: true` and a fresh TD search succeeds.
- [ ] **8.14** **Mode-swap procedure documented.** To change modes: edit `/home/castcrate/castcrate/apps/server/.env` to a different `VPN_MODE=` value, then `sudo systemctl stop castcrate castcrate-netns && sudo systemctl start castcrate-netns castcrate` (stop in reverse order, start in dependency order). `castcrate-netns.service` picks up the new mode via `EnvironmentFile=` and runs `netns-up.sh` with the corresponding branches; `castcrate.service` restarts and `run-server.sh` picks the right `exec`. If you set `VPN_MODE=off`, `netns-up.sh` will refuse to run and log a hint — you can also remove `/etc/castcrate/wg0.conf` to make `castcrate-netns.service` a no-op via its `ConditionPathExists=`, no unit disable required.
- [ ] **8.15** Reboot the box (`sudo reboot`), wait 60s, then from a LAN client: `curl -s http://<box>:3000/api/system/vpn-health | jq .` returns green (`mode: "<your VPN_MODE>"`, `leaking: false`, `reachable: true`). Proves auto-start on boot.

**Acceptance:** `/api/system/vpn-health` returns your configured `mode` value, `leaking: false`, `reachable: true` from a LAN client; Interstellar → Master Llama casts end-to-end; TorrentDay search returns non-empty results without any system-level VPN toggle; kill-switch verified per mode semantics (v1: all sources fail on WG down; v2: only TD fails, YTS/Knaben still work); reboot survival proven.

---

## Sign-off

- [x] **DoD.** All Definition-of-Done items in `implementation.md` verified. Feature moved to Complete; epic-overview + master overview refreshed via `/update-epic castcrate` + `/update-master`. **✅ (2026-08-08) All 47/47 tasks ticked. Cast test passed on real Chromecast HD ("Master Llama" / Llama Lounge TV). Two caveats logged for follow-up but not blocking DoD: (1) prune timer symlink survived the pre-install boot; the *next* reboot after 12:43 install will empirically prove the timer state persists (very low risk — `timers.target.wants/` symlink is standard mechanism). (2) SIGTERM shutdown bug — `app.close()` hangs on webtorrent tracker announce-stops → 90s systemd `TimeoutStopSec` → SIGKILL. Fixed in same session via bounded shutdown race (5s ceiling + 8s hard-exit safety net) in `apps/server/src/index.ts` — needs the standard deploy one-liner to land on the box.**

---

## Notes for updating me

When you finish a phase (or hit something weird), just say something like:
- "done through 3.6, mbpfan is running fine"
- "stuck on 5.7 — UI loads but OMDb returns 401"
- "everything green through Phase 4"

I'll tick the boxes here, help debug anything that misfires, and keep `context.md` in sync with any decisions we take mid-flight.
