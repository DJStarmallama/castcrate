# hardening — Task checklist

**Last updated:** 2026-05-09
**Progress:** Phase A complete — 1 / 5 phases

---

## Phase A — Docs & one-line correctness ✅

- [x] **A1.** Add `TRANSCODE_BUFFER_PERCENT`, `TRANSCODE_BITRATE`, `FFMPEG_PATH`, `YTS_BASE_URL`, `KNABEN_BASE_URL`, `DNS_BYPASS`, `DNS_UPSTREAMS` to `.env.example` with comments
- [x] **A2.** Move `YTS_BASE_URL` from `services/yts.ts` into `lib/config.ts`
- [x] **A3.** Pass `{ sequentialDownload: true }` to `client.add(...)` in `services/torrent.ts`
- [x] **A4.** Brand: pick `Llama Spit Stream` (already chosen in `index.html` + `App.tsx`); update `.env.example` `DOWNLOAD_PATH` default and README env table + legal section to match
- [x] **A5.** Update `TorrentPicker.tsx` empty-state copy to use the `tried` array from API response (also threaded `tried` through the web `api.searchTorrents` type)

**Acceptance:** ✅ `pnpm typecheck` clean; `pnpm test` 51/51 passing.

---

## Phase B — Server hardening

- [ ] **B1.** Atomic `history.json` writes (temp file + `fs.rename`)
- [ ] **B2.** ffmpeg subprocess registry in `services/transcoder.ts`; `onClose` hook in `apps/server/src/index.ts` kills active processes on shutdown
- [ ] **B3.** Append history on cast start in `routes/cast.ts` `/api/cast/play`; coordinate with the existing removal-time append (avoid double-write)
- [ ] **B4.** Pre-buffer timeout (30s, configurable) in `/stream/:hash` — return 504 if first byte never arrives; do not time out reads after first byte
- [ ] **B5.** `revalidateFfmpeg()` in `services/transcoder.ts`; surface via `/api/system/check` so smooth-playback toggle re-checks on demand

**Acceptance:** Manual `kill -9` mid-transcode leaves no orphan ffmpeg; cast-only sessions appear in `~/.castcrate/history.json`; `pnpm test` adds atomic-write recovery + ffmpeg cleanup tests.

---

## Phase C — UX polish

- [ ] **C1.** "Stop only" vs "Stop & delete files" prompt on torrent removal in `Library.tsx`; wire `?destroy=true` to `DELETE /api/torrent/:hash`; forward `{ destroyStore: true }` to WebTorrent
- [ ] **C2.** Optimistic UI for seek/volume in `CastControls.tsx` — local state updates immediately, reconciles on next poll
- [ ] **C3.** Stalled-stream warning in `Player.tsx` when `progress` unchanged for 10s while `!done`
- [ ] **C4.** Stop-or-slow status polling once `done === true` in `Player.tsx` (drop to 30s or unsubscribe)

**Acceptance:** Manual smoke test for each item.

---

## Phase D — Test coverage + CI

- [ ] **D1.** Vitest fixtures for `services/omdb.ts` (search, detail, season episodes, error paths)
- [ ] **D2.** Vitest fixtures for `services/knaben.ts` API responses (success, empty, error, malformed)
- [ ] **D3.** Integration test for `DELETE /api/torrent/:hash` → `appendHistory` write
- [ ] **D4.** Corrupted-JSON recovery test for `services/history.ts` (missing, malformed, partial)
- [ ] **D5.** `.github/workflows/ci.yml` — `pnpm typecheck`, `pnpm lint`, `pnpm test` on PR + push to main; Node 22, pnpm 11

**Acceptance:** `pnpm test` green on fresh checkout; CI runs and passes on the PR for this feature.

---

## Phase E — Deferred (not in scope)

Each item is feature-sized; spawn `/start-feature` when ready.

- [ ] **E1.** WebSocket push for cast + torrent state
- [ ] **E2.** Auto-transcode trigger from codec probe (HEVC, AV1, high-bitrate)
- [ ] **E3.** Manual file picker for multi-file torrents
- [ ] **E4.** Editable settings (PATCH `/api/settings` → `~/.castcrate/settings.json`)
- [ ] **E5.** Knaben season-pack search path
- [ ] **E6.** Per-indexer DNS-bypass scoping

---

## Working notes

Add session notes as work progresses:

- _(none yet — feature has not started)_
