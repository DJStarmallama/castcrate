# hardening — Task checklist

**Last updated:** 2026-05-10
**Progress:** Phases A–E complete — every hardening item shipped.

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
- [x] **B2.** `activeProcesses: Set<ChildProcessWithoutNullStreams>` in `services/transcoder.ts`; `shutdownTranscodes()` exported and wired into the Fastify `onClose` hook in `index.ts`. Two-phase shutdown: SIGTERM first, per-process `exit` await, SIGKILL after 2s per process; returns once every process is confirmed exited so the bounded shutdown in `index.ts` doesn't race (2026-08-09 follow-on).
- [x] **B3.** `/api/cast/play` appends history on cast start with `historyId` saved on `TorrentMeta`; `DELETE /api/torrent/:hash` updates that entry instead of duplicating
- [x] **B4.** First-byte timeout on `/stream/:hash` **and `/stream/:hash/transcoded`** — returns 504 if WebTorrent never delivers the first chunk (or ffmpeg never produces output). Default 60s, configurable via `STREAM_FIRST_BYTE_TIMEOUT_MS` env var (2026-08-09 follow-on: transcoded coverage + env plumbing + default bumped 30s → 60s).
- [x] **B5.** `checkFfmpeg(force = false)` accepts an explicit re-probe; `/api/system/check?refresh=1` triggers it (lets the Settings toggle re-check after a fresh ffmpeg install)
- [x] **B6.** `meta` map cleanup on external torrent removal — `torrent.once("close", ...)` in `startTorrent` deletes the map entry when webtorrent destroys the torrent from its own error paths (client.destroy, unrecoverable torrent errors) (2026-08-09 follow-on).
- [x] **B7.** Idempotency test for `removeTorrent` — `apps/server/src/services/__tests__/torrent.test.ts` mocks the webtorrent client, asserts the second `removeTorrent()` call swallows "No torrent with id ..." without throwing; also covers meta cleanup, `destroyStore` forwarding, and that unrelated errors still propagate (2026-08-09 follow-on).

**Acceptance:** ✅ `pnpm typecheck` clean; `pnpm test` 222/222 (was 218 pre-2026-08-09; +4 tests from `torrent.test.ts`). Build clean.

---

## Phase C — UX polish ✅

- [x] **C1.** Inline confirm in `Library.tsx` ActiveRow: "Stop only" / "Stop & delete" / cancel ✕; `api.removeTorrent(infoHash, { destroy })` passes `?destroy=1`; `removeTorrent` in `services/torrent.ts` forwards `{ destroyStore }` to WebTorrent
- [x] **C2.** `optimisticSeek` and `optimisticVolume` state in `CastControls.tsx`; reconciles when server poll catches up (within 2s for seek, 0.05 for volume) or after a 3s safety net
- [x] **C3.** `STALL_THRESHOLD_MS = 10_000`; ref tracks last progress change; ProgressBar renders amber warning copy + amber bar when stalled
- [x] **C4.** `refetchInterval: (q) => q.state.data?.done ? false : 1500` — polling stops once the torrent finishes

**Acceptance:** ✅ `pnpm typecheck` clean; `pnpm test` 54/54. Manual smoke test still required for each (UI behaviour).

---

## Phase D — Test coverage + CI ✅

- [x] **D1.** `omdb.test.ts` — 9 tests with mocked `fetch`: type-filtered search, interleaved search, mid-typing empty, invalid-key 401, DNS 502, detail parsing (runtime/genres/cast/rating), IMDb-ID validation rejects without network call, series totalSeasons, season-episode mapping
- [x] **D2.** `knaben.test.ts` extended with 6 `_internals.toResult` tests: magnetUrl > magnet > built-from-hash precedence, null when none of those, xvid filter, season/episode passthrough
- [x] **D3.** `history.test.ts` adds a contract test for the cast-start → removal flow — append + updateHistoryById → single entry with merged endedAt + completed
- [x] **D4.** `history.test.ts` `vi.resetModules()`-based recovery suite: malformed JSON, truncated write, missing file → all return `[]` without throwing
- [x] **D5.** Already in place at `.github/workflows/ci.yml`: install + lint + typecheck + test + build on push/PR (Node 22, pnpm via `pnpm/action-setup@v4`)

**Acceptance:** ✅ `pnpm typecheck` clean; `pnpm test` 73/73 (was 51 at start of Phase A — +22 tests).

---

## Phase E — Deferred (not in scope)

Each item is feature-sized; spawn `/start-feature` when ready.

- [x] **E1.** WebSocket push for cast + torrent state — `services/events.ts` socket registry + 1s torrent broadcaster, `routes/ws.ts` `/ws` endpoint, cast.ts emits `cast:status`/`cast:closed` on every receiver event. Client `useWsBridge` hydrates the TanStack Query cache; component polling drops from 1s/1.5s/2s to a 10s safety net.
- [x] **E2.** Auto-transcode for HEVC/H.265/AV1 — TorrentMeta tracks `videoCodec`, `StartTorrentResult` returns it, Player auto-routes through `/transcoded` when the source codec isn't Chromecast-friendly. User toggle still wins as override.
- [x] **E3.** Manual file picker — `GET /api/torrent/:hash/files` lists video files; `POST /api/torrent/:hash/file { index }` selects one (deselects others, raises priority on the new pick). Player renders a `<select>` in the header for multi-file torrents and re-keys the `<video>` so the new file streams immediately.
- [x] **E4.** Editable settings — `services/settings.ts` layered (env defaults + `~/.castcrate/settings.json` overrides, atomic write); `GET /api/settings`, `PATCH /api/settings` for `bufferPercent`, `transcodeBufferPercent`, `transcodeBitrate`. Transcoder now reads bitrate live; Settings UI has editable form with Save button.
- [x] **E5.** Knaben season-pack search path — `searchKnabenSeasonPack()` + `seasonPackMatchesTitle()`; wired into `/api/search/torrents/episode` when EZTV pack is empty
- [x] **E6.** Per-indexer DNS-bypass scoping — substring allowlist (default `yts,eztv,knaben`); other hostnames (mDNS, OMDb, etc.) use the OS resolver. `DNS_BYPASS_HOSTS=*` reverts to legacy global mode.

---

## Working notes

Add session notes as work progresses:

- **2026-08-09 — Phase B follow-on.** Feature was marked complete in tasks.md before production hardware deploy, but the post-deploy bug chain (webtorrent v2 double-remove crash `4cb84d9`, tilde-in-env-file sandbox escape, silent post-ready error swallowing) surfaced gaps the original Phase B pass missed. This session:
  - **Stream timeout expansion (B4).** Bumped default 30s → 60s, made it configurable via `STREAM_FIRST_BYTE_TIMEOUT_MS`, and extended the guard to `/stream/:hash/transcoded` (previously only `/stream/:hash` was protected — an ffmpeg subprocess that never got any input bytes would hang the client forever).
  - **Meta map leak (new B6).** Added `torrent.once("close", ...)` in `startTorrent` so meta entries are cleared when webtorrent destroys a torrent from its own error paths, not only when `removeTorrent()` is called. Belt-and-braces — `removeTorrent()` still clears it, but if webtorrent tears a torrent down first (e.g. unrecoverable error), the entry no longer leaks for the process lifetime.
  - **`shutdownTranscodes` rewrite (B2).** Previous version blocked for a flat 1.5s regardless of how long ffmpeg actually took. Now: SIGTERM every process first, await each process's `exit` event with a per-process 2s ceiling, SIGKILL any process that hasn't exited by the deadline, return once every process is confirmed done. Matches the brief's "await their exit with a short 2s per-process timeout, then SIGKILL" and no longer wastes shutdown budget on a fixed delay.
  - **Idempotency test (new B7).** Added `apps/server/src/services/__tests__/torrent.test.ts` — mocks the webtorrent client, asserts the second `removeTorrent()` call swallows the "No torrent with id ..." rejection without throwing (regression coverage for `4cb84d9`), plus meta cleanup, `destroyStore` forwarding, and that unrelated rejections still propagate.
  - Test count 218 → 222; typecheck + build clean.
