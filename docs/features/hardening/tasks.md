# hardening — Task checklist

**Last updated:** 2026-05-09
**Progress:** Phases A+B+C complete — 3 / 5 phases

---

## Phase A — Docs & one-line correctness ✅

- [x] **A1.** Add `TRANSCODE_BUFFER_PERCENT`, `TRANSCODE_BITRATE`, `FFMPEG_PATH`, `YTS_BASE_URL`, `KNABEN_BASE_URL`, `DNS_BYPASS`, `DNS_UPSTREAMS` to `.env.example` with comments
- [x] **A2.** Move `YTS_BASE_URL` from `services/yts.ts` into `lib/config.ts`
- [x] **A3.** Pass `{ sequentialDownload: true }` to `client.add(...)` in `services/torrent.ts`
- [x] **A4.** Brand: pick `Llama Spit Stream` (already chosen in `index.html` + `App.tsx`); update `.env.example` `DOWNLOAD_PATH` default and README env table + legal section to match
- [x] **A5.** Update `TorrentPicker.tsx` empty-state copy to use the `tried` array from API response (also threaded `tried` through the web `api.searchTorrents` type)

**Acceptance:** ✅ `pnpm typecheck` clean; `pnpm test` 51/51 passing.

---

## Phase B — Server hardening ✅

- [x] **B1.** Atomic `history.json` writes (temp file + `fs.rename`); added `updateHistoryById` for in-place edits
- [x] **B2.** `activeProcesses: Set<ChildProcessWithoutNullStreams>` in `services/transcoder.ts`; `shutdownTranscodes()` exported and wired into the Fastify `onClose` hook in `index.ts` (SIGTERM, then SIGKILL after 1.5s)
- [x] **B3.** `/api/cast/play` appends history on cast start with `historyId` saved on `TorrentMeta`; `DELETE /api/torrent/:hash` updates that entry instead of duplicating
- [x] **B4.** First-byte timeout (30s) on `/stream/:hash` — returns 504 if WebTorrent never delivers the first chunk; does not affect reads once flowing
- [x] **B5.** `checkFfmpeg(force = false)` accepts an explicit re-probe; `/api/system/check?refresh=1` triggers it (lets the Settings toggle re-check after a fresh ffmpeg install)

**Acceptance:** ✅ `pnpm typecheck` clean; `pnpm test` 54/54 (3 new tests for updateHistoryById and atomic-write tmp cleanup).

---

## Phase C — UX polish ✅

- [x] **C1.** Inline confirm in `Library.tsx` ActiveRow: "Stop only" / "Stop & delete" / cancel ✕; `api.removeTorrent(infoHash, { destroy })` passes `?destroy=1`; `removeTorrent` in `services/torrent.ts` forwards `{ destroyStore }` to WebTorrent
- [x] **C2.** `optimisticSeek` and `optimisticVolume` state in `CastControls.tsx`; reconciles when server poll catches up (within 2s for seek, 0.05 for volume) or after a 3s safety net
- [x] **C3.** `STALL_THRESHOLD_MS = 10_000`; ref tracks last progress change; ProgressBar renders amber warning copy + amber bar when stalled
- [x] **C4.** `refetchInterval: (q) => q.state.data?.done ? false : 1500` — polling stops once the torrent finishes

**Acceptance:** ✅ `pnpm typecheck` clean; `pnpm test` 54/54. Manual smoke test still required for each (UI behaviour).

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
