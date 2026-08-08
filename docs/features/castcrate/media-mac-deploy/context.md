# media-mac-deploy — Context

**Last updated:** 2026-08-08

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

### 2026-08-08 — Post-crash-fix retest: crash gone, streaming still broken (peer starvation or start-flow bug)

- Crash fix verified: PID stable across a 5-minute cast attempt (`3610` throughout, no restarts, no `Main process exited`).
- **But streaming still 504s**: `/stream/<hash>` never delivers a first byte within the 30-second hardening timeout for the Matrix release we've been using (`d7a46713eaee18c746b3254b7d1492a50fd9d6ce`).
- Log signature: `POST /api/torrent/start` returns 200 (2s), then `/api/torrent/:hash` (status) starts returning **404** almost immediately while `/stream/:hash` hangs → 504 after 30s. Interpretation: either the torrent silently fails to add / self-removes with 0 peers, or the specific release has no reachable seeders.
- **Two suspects to differentiate with an Interstellar YTS 1080p test:**
  - **Environmental — Starlink CGNAT.** Inbound peer connections blocked; only reachable seeders would be UPnP-open or public trackers. Mitigation: IPv6, or route through the existing `PROXY_URL` SOCKS5 (Mullvad).
  - **Code bug — `startTorrent` reports success without actually adding.** Route returns 200 even when `client.add()` fails silently. Worth a follow-up feature; not the deploy's blocker.
- Also noted a **log-reading gotcha**: `/api/torrent/:hash/files` returns 200 with an empty array if the torrent is gone (via `listVideoFiles` returning `[]`) — that's not proof the torrent exists. Only `/api/torrent/:hash` (status) tells you if the torrent is actually in webtorrent's client.
- **Deploy decision:** the crash fix unblocks Phase 6.3 ✅. The playback/streaming problem is now a separate diagnostic — differentiate with the Interstellar test. Cast test (6.4) is still blocked by the player-UX z-index bug regardless of stream health. Recommend proceeding to Phase 7 (prune timer) and returning to streaming diagnosis + player-buffer-ux Phase 6 as focused follow-ups.

### 2026-08-08 — Phase 6 in progress + one crash bug fixed en route

- **6.1 systemd unit written** (heredoc paste got mangled first attempt — bash's `>` PS2 was waiting for the closing `UNIT` marker; second attempt via `sudo nano` succeeded). Learning for future runbooks: **prefer `nano`-created files over heredoc `sudo tee` for anything longer than ~10 lines** on macOS Terminal.app SSH sessions, which have unreliable paste for large blocks.
- **6.2/6.3 enable + verify** — service active, PID 3275, ~44 MB RSS, listening on both 127.0.0.1:3000 and 192.168.1.249:3000.
- **⚠️ Crash bug found and fixed mid-Phase 6:** browser-side "very high buffering" was actually the service crash-looping every ~50s. Root cause: `DELETE /api/torrent/:hash` calls `webtorrent.remove()` on already-removed torrents, and webtorrent v2 throws synchronously; the throw escaped the callback wrapper → unhandled rejection → process exit → systemd restart. Fix in `apps/server/src/services/torrent.ts` short-circuits when `client.get(infoHash)` returns null; committed `dc8fe0c`, pushed. Pull + rebuild + restart in progress on the media Mac.
- **Player UX bugs from P5.7** now formally planned as **Phase 6 of `castcrate/player-buffer-ux`** (see that feature's `implementation.md` → "Overlay layering fix pass" and `tasks.md` → Phase 6). Approach borrowed from Jellyfin's `jellyfin-web` player architecture (portal + z-index + `pointer-events` — reimplemented, not copied; Jellyfin is GPLv2).

### 2026-08-08 — Phase 5.7 manual test PASSED (with player UX findings)

- CastCrate reachable at `http://192.168.1.249:3000` from the main laptop.
- Search "The Matrix" → OMDb metadata + releases returned → played the movie in-browser end-to-end. Streaming pipeline (webtorrent → transcode → HTTP-range) works.
- **Player UX bugs found and logged into `castcrate/player-buffer-ux/context.md`** (buffer bar won't dismiss; cast + captions buttons hidden behind the video element — z-index/stacking issue). Deferred until after Phase 7.
- Deploy proceeds: Ctrl+C the server, move to Phase 6 (systemd), then Phase 7 (prune), then circle back to fix the player UX.

### 2026-08-08 — Corrections: crash fix NOT yet deployed; peer starvation confirmed environmental (Starlink CGNAT)

**Correction to the earlier "crash fix verified" entry.** That verdict was wrong. When the user ran the retest they only pasted `sudo systemctl restart castcrate` and NOT the `git pull && pnpm build` beforehand. So the running `dist/index.js` on PID 3610 was still the pre-fix code. The Matrix cast attempt therefore ran on old code; the eventual DELETE (when the browser tab was closed at 03:27:58) crashed identically to the original bug:

```
Error: No torrent with id d7a46713...
  at WebTorrent.remove (.../webtorrent/index.js:408:25)
systemd[1]: castcrate.service: Main process exited, code=exited, status=1/FAILURE
Scheduled restart job, restart counter is at 1
```

Systemd restarted (PID 3610 → 3802). The Interstellar test then ran on the fresh PID, still against the old code.

**Peer starvation confirmed environmental — not release-specific:** Interstellar YTS 1080p test (03:28:38 onward, hash `89599bf4dc369a3a8eca26411c5ccf922d78b486`) shows exactly the same signature as Matrix. `POST /api/torrent/start` returns 200 in ~2 s, status endpoint immediately 404s, `/stream/<hash>` hangs → 504 at 03:29:11 (exact 30-second first-byte timeout). Interstellar YTS has thousands of active seeders; if it can't fetch a single byte in 30 s, **the box cannot establish outbound BitTorrent peer connections**. That is Starlink CGNAT behaviour.

**Two independent fixes now required, in order:**

1. **Actually deploy the crash fix** — one paste:
   ```
   cd ~/castcrate && git pull && pnpm --filter @castcrate/server build && sudo systemctl restart castcrate
   ```
   Verify commit `dc8fe0c` (`fix(server): make DELETE /api/torrent/:hash idempotent`) is in the `git log -1` after pull.

2. **Bypass CGNAT for torrents.** Three options, in order of ease:
   - **a. SOCKS5 via `PROXY_URL`** — CastCrate already supports it. Sample: `PROXY_URL=socks5h://user:password@socks5.mullvad.net:1080` in `apps/server/.env`. Needs Mullvad or ProtonVPN credentials. 5-minute change.
   - **b. Enable Starlink IPv6.** Starlink app → Settings → toggle IPv6. Many peers speak IPv6, which bypasses CGNAT because IPv6 doesn't NAT. Free, effectiveness varies by swarm.
   - **c. Full WireGuard/OpenVPN on the box.** Wraps all traffic, not just torrents. Overkill if only torrents fail.

**Also newly logged (P5 code bug, follow-up):** `POST /api/torrent/start` returns 200 even when webtorrent's `client.add()` never actually completes / fails silently. The route should surface this as a 502 (or wait on the `ready`/`error` event before returning success), otherwise the client thinks the torrent started when it didn't. Not the deploy blocker (CGNAT is), but a worthwhile server-side hardening task — should be planned as its own small feature or folded into `hardening` v2.

> **⚠️ SUPERSEDED by the "Root cause found" entry below.** Both the "Starlink CGNAT peer starvation" diagnosis and the "`start` returns 200 optimistically" follow-up were wrong. See the next entry for what was actually happening.

### 2026-08-08 — Root cause found: systemd sandbox blocked the write path (NOT CGNAT)

The "Starlink CGNAT peer-starvation" diagnosis in the previous entry was **wrong**. Root cause was a stray tilde in the box's `.env`: `DOWNLOAD_PATH=~/home/castcrate/castcrate-downloads`. `config.ts:14` runs `expandTilde()` on the value, resolving it to `/home/castcrate/home/castcrate/castcrate-downloads` — outside the systemd unit's `ReadWritePaths=/home/castcrate/castcrate-downloads`. `ProtectHome=read-only` blocked the first-piece flush → webtorrent tore the torrent down → status went 404 → `/stream` timed out at 30 s. Physical proof: **1.9 GB of "The Matrix (1999) [1080p]"** sitting at the wrong path from the P5.7 manual test — which passed *because* it ran outside systemd, where `/home` was writable. "Works manually, fails under systemd" was the tell.

**Peer connectivity is fine on this network.** Polling every 5 s during a live start (before the write failure killed the torrent) showed **33 peers @ 1.09 MB/s at t=10s**; Interstellar swarm metadata resolved in 1.4 s with an empty download dir. After the `.env` tilde was fixed and the service restarted: `/stream` returns **206 Partial Content in 17 ms**, sustains **11.7 MB/s over 49 peers**. Streaming works over Starlink CGNAT with **no proxy, no IPv6, no VPN**. The "Two independent fixes now required" plan in the previous entry — specifically Step 2 (CGNAT bypass via SOCKS5 / IPv6 / VPN) — is chasing a non-problem. **Dropped.**

**Crash fix `4cb84d9` confirmed under real load** — DELETE issued against a *live* torrent, twice: PID stable, `NRestarts=0`, zero crashes, zero `No torrent with id`.

**Three source bugs found and fixed (commit `1d65f44`):**

- **Bug A (HIGH)** — post-`ready` torrent errors silently swallowed. `startTorrent`'s `torrent.once("error", ...)` handler only rejects the setup promise; after `finalize()` fires on 'ready', the reject is a no-op. Runtime failures (like the EROFS write above) produced **zero** journal output — this is why three sessions blamed the network instead of the disk. Fix: `torrent.on` + unconditional `console.error`.
- **Bug B (LOW)** — `.env.example` shipped `DOWNLOAD_PATH=~/Downloads/LlamaSpitStream`. Fine under a shell, silently hostile under systemd (`EnvironmentFile=` does not expand tildes). Added warning comments plus a parallel `HISTORY_DIR` block.
- **Bug C (HIGH)** — `DELETE /api/torrent/:hash` was leaking torrents. `history.ts` hardcoded `join(homedir(), ".castcrate")` — outside the sandbox's `ReadWritePaths` → ENOENT on mkdir → 500. The route wrote history **before** calling `removeTorrent()`, so the throw skipped removal entirely and the torrent kept downloading forever (unbounded bandwidth + disk). Fix: honor `HISTORY_DIR` env, reorder to `removeTorrent()` first + history in its own try/catch that logs + swallows.

**Common shape of all three bugs:** a write path outside the sandbox's `ReadWritePaths`, with the error swallowed before reaching the journal. Bug A is the leverage fix — it's what turns the next instance of this from a day of guesswork into a minute of `grep`.

**Deploy state:** 6.4's crash-fix half is done. Cast test (6.4) still blocked only by player z-index bugs (`castcrate/player-buffer-ux` Phase 6) and needing a real Chromecast. The whole CGNAT bypass workstream is dropped from scope.

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
- **Chromecast device name(s):** Llama Lounge TV (Chromecast, 192.168.1.47), **Master Llama** (Chromecast HD, 192.168.1.71 — **recommended target for the 6.4 cast test**: idle, and Chromecast HD matches the runbook's direct-cast/x264 golden path), Llama Lounge display (Nest Hub Max, 192.168.1.131 — avoid for first test; a playback failure on a smart display could be device quirks rather than CastCrate). All three resolve via `avahi-browse -art` AND via CastCrate's own `/api/cast/devices` (verified 2026-08-08).

## Known gotchas we've hit

- **macOS Terminal.app + large SSH paste = corruption.** Multi-line pastes >10 lines routinely drop/mangle characters. Symptoms: unexplained `command not found`, `>` PS2 prompt hanging (unterminated heredoc), invisible chars mid-command. Fix: split into ≤3-line chunks, or use `sudo nano` for anything file-shaped.
- **Ubuntu 26.04 installer uses LVM by default even when "Use LVM" appears unchecked.** Root LV is created at 100 GB, leaving ~344 GB unallocated on a 500 GB SSD. Fix: `sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv && sudo resize2fs /dev/ubuntu-vg/ubuntu-lv` — live, zero-downtime.
- **NodeSource `setup_22.x` on Ubuntu 26.04 works cleanly** — repo entry is `nodistro/main`, codename-agnostic, so no fallback to `noble` needed.
- **GRUB recovery mode on Mac EFI is unreliable.** Holding Shift to catch the GRUB menu misses on this hardware. If a password is lost, **reinstalling from USB is faster than the chroot-passwd dance.**
- **Password auth over SSH may be off after Ubuntu installer imports a GitHub key.** Symptom: `Permission denied (publickey)` even with the correct password. Fix at the physical console: `sudo sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf && sudo systemctl restart ssh`.
- **CastCrate DELETE crash + peer-starvation combo can masquerade as "buffering".** Under systemd `Restart=on-failure`, a crash-loop looks like intermittent slowness to the browser client. Always check `journalctl -u castcrate | grep -c "Main process exited"` before assuming a client-side or network issue.
- **`/api/torrent/:hash/files` returns `200 []` when the torrent is gone.** Only `/api/torrent/:hash` (status) returns a definitive 404 when webtorrent has no such torrent. Don't use `/files` as a liveness check.
- **Starlink CGNAT does NOT block BitTorrent on this network.** The earlier entry that pinned peer-starvation on CGNAT was wrong — sustained 11.7 MB/s over 49 peers once the real bug (sandbox blocking the write path) was fixed. **CGNAT is a very tempting scapegoat when torrents look dead; check the write path first.**
- **systemd `EnvironmentFile=` does NOT expand `~`.** A `.env` line like `DOWNLOAD_PATH=~/foo` is fine under a shell but under systemd resolves through `config.ts::expandTilde()` to `<cwd>/~/foo` — outside `ReadWritePaths`, blocked by `ProtectHome=read-only`, torrents die silently on the first piece flush. Use absolute paths in any `.env` a systemd unit will load, and make `ReadWritePaths=` match the *expanded* path exactly.
- **`~/.castcrate` is unwritable under `ProtectHome=read-only`.** The old `history.ts` hardcoded that path and 500'd on every DELETE. Set `HISTORY_DIR=` (env) to a path inside `ReadWritePaths=` — or use systemd `StateDirectory=castcrate` which hands you `/var/lib/castcrate` for free and adds it to `ReadWritePaths` automatically.
- **Sandboxed write failures show up as "network problems" if the error handler doesn't log.** Bug A (torrent runtime-error swallow) is what let the tilde bug hide as CGNAT for three sessions. When post-'ready' errors reach `console.error`, `journalctl -u castcrate | grep -i EROFS` finds the real cause in seconds.
