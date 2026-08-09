# subtitles — Context

**Last updated:** 2026-08-09
**Status:** Implemented (retrospective doc) + OpenSubtitles fallback

## Status

- Side-loaded SRT/VTT still primary; **OpenSubtitles fallback now enabled** when `OPENSUBTITLES_API_KEY` is set (2026-08-09)
- SRT→VTT conversion via `lib/srt.ts` (well-tested) — reused for OpenSubtitles-sourced content
- Browser `<track>` and Chromecast MediaTextTracks both work
- **Runtime track switching during an active cast: implemented (2026-08-09)** via `EDIT_TRACKS_INFO` — no reload, no playback interruption
- Subtitle picker polls track list at 3s until tracks appear; OpenSubtitles arrives on first hit
- `SubtitleTrack` in `@castcrate/shared` is now a **discriminated union** on `source: "torrent" | "opensubtitles"`

## Key files

- `apps/server/src/services/subtitles.ts` — discovery + merge (torrent + OpenSubtitles), language guessing, VTT delivery
- `apps/server/src/services/opensubtitles.ts` — OpenSubtitles REST v1 adapter (search + download + disk cache)
- `apps/server/src/lib/srt.ts` — SRT→VTT
- `apps/server/src/routes/subtitles.ts` — list + body endpoints (torrent AND OpenSubtitles)
- `apps/server/src/services/cast.ts` — MediaTextTrack wiring, `setActiveTracks()` (EDIT_TRACKS_INFO), `CastSessionNotFoundError` / `UnknownTrackIdError`
- `apps/server/src/routes/cast.ts` — LAN-IP subtitle URL, enumerate-upfront in `/api/cast/play`, `POST /api/cast/sessions/:id/tracks`, `OS_TRACK_ID_BASE` namespace
- `apps/server/src/lib/config.ts` — `openSubtitlesApiKey`, `openSubtitlesLanguages`
- `apps/web/src/components/SubtitlePicker.tsx`, `Player.tsx`, `CastBar.tsx`
- `apps/web/src/lib/api.ts` — `setCastActiveTracks`, `subtitleTracks(infoHash, imdbId?)`
- `packages/shared/src/index.ts` — `CastMediaTrack`, `SetActiveTracksRequest`, `SubtitleTrack` (discriminated union)
- `apps/server/src/lib/__tests__/srt.test.ts`
- `apps/server/src/services/__tests__/opensubtitles.test.ts` — 12 cases (disabled/happy/errors/download cache)

## Decisions

- **No external API.** Side-loaded only. Avoids OpenSubtitles auth + rate limits + legal grey area.
- **SRT→VTT on demand, not pre-converted.** Cheap; lets us handle weird encodings centrally.
- **CORS `*`.** Chromecast fetches the URL; dev proxy may rewrite origins. LAN-only, low risk.
- **Re-key the `<video>` on subtitle change.** Browsers cache `<track>` aggressively; re-key forces re-parse.
- **Single active track on Chromecast** — the receiver can display only one subtitle stream at a time (Cast SDK supports arrays for e.g. captions + audio-description overlay; we don't expose that).
- **Enumerate all tracks upfront at cast start** — so `EDIT_TRACKS_INFO` can hot-swap without a reload. Trade-off: cast start does an extra `listSubtitles()` scan, which walks the torrent's file list. Cheap for normal torrents.
- **trackId = subtitle.index + 1.** Keeps `0` reserved; makes the client-side mapping trivial.

## Gotchas

- **No encoding detection.** Non-UTF-8 SRT yields garbage. Add chardet+iconv if it bites.
- **Language heuristic is filename-based.** Ambiguous → "Subtitles".
- **No cache.** Track list is recomputed per request; fine for normal torrents, slow for 200-file torrents.
- **CORS `*` is permissive.** Tighten if you ever serve from a real domain.
- **Subtitle file isn't priority-bumped** in WebTorrent — user sees "no tracks" until normal download reaches it.
- ~~**No runtime multi-track switching.** Stop + replay to change.~~ Resolved 2026-08-09 — see below.
- **VTT line endings are LF.** Some legacy Chromecast firmware prefers CRLF.
- ~~**Subtitle picker is a no-op during an active cast session.**~~ **Resolved 2026-08-09** via option 1 (enumerate-upfront + `EDIT_TRACKS_INFO`).
  - **Server** (`routes/cast.ts`): on `/api/cast/play`, enumerate ALL subtitle tracks from the torrent (`listSubtitles(infoHash)`) and pass them into `PlayParams.tracks` — not just the one the user picked. `activeTrackIds` is `[]` when no subtitle was picked, or `[trackId]` for the selected one. Empty array is mandatory (receiver rejects `undefined`).
  - **Server** (`services/cast.ts`): each session stores the `knownTrackIds` set. New `setActiveTracks(sessionId, ids)` validates every id is known, then dispatches `player.media.sessionRequest({ type: "EDIT_TRACKS_INFO", activeTrackIds })`. `castv2-client 1.2.0` doesn't expose `editTracksInfo` on `DefaultMediaReceiver` — we use the underlying `MediaController.sessionRequest` (adds `mediaSessionId` automatically).
  - **Route**: new `POST /api/cast/sessions/:sessionId/tracks` with body `{ activeTrackIds: number[] }`. 404 on unknown session, 400 on unknown trackIds or malformed body.
  - **Web** (`SubtitlePicker.tsx`): accepts `castSessionId?: string | null`; when set, `handleSelect` also POSTs to the new endpoint. Local `<video>`'s `<track>` still updates (harmless when the tab isn't visible; useful when the user pops back).
  - **trackId scheme**: `subtitle.index + 1`. Convention documented in `PlayTrack.trackId` and mirrored client-side in `SubtitlePicker.trackIdFor()`. Avoids `0`, which some receiver firmware treats as "no track".
  - **Untouched** for later: HTTP-stream (Stremio debrid) cast sessions still can't hot-swap — no server-side torrent to enumerate from. They keep the old single-track behavior via the explicit `subtitlePath` fallback.
  - **Related, not fixed here**: "Subtitle track has no fallback if torrent disappears mid-cast" — if the torrent is stopped while a cast is running, the subtitle URLs become unreachable and the Chromecast silently drops the track. Called out as a comment in `routes/cast.ts`.
  - Original report: user during `castcrate/media-mac-deploy` P6.4 cast test — "Wish I could trigger subtitles whilst its casting."

## Session notes

### 2026-08-09 — Cast-side subtitle hot-swap

- Added `SetActiveTracksRequest` + `CastMediaTrack` to `@castcrate/shared`.
- New route + service function + client API method + `SubtitlePicker` wiring — see resolution note above.
- Test result: verified via `pnpm --filter @castcrate/server build`, `pnpm --filter @castcrate/server test` (218/218 pass), and `pnpm --filter @castcrate/web build`. **No real-device cast test in this pass** — the change should be exercised on the media-mac deploy with a multi-subtitle torrent (e.g. an anime release with English + Japanese SRTs). Pre-existing lint failures in `Player.tsx`, `CastControls.tsx`, `Settings.tsx` are unrelated (already on HEAD).
- castv2-client surprise: `DefaultMediaReceiver` proxies `load / play / pause / stop / seek / setVolume / queueLoad / …` but **not** `editTracksInfo`. Reach into `player.media.sessionRequest(...)` (the underlying `MediaController`) — that method already stamps the `mediaSessionId` on the request.

### 2026-08-09 — OpenSubtitles fallback source

Context: the user hit a real UX gap while casting a YTS release — YTS movies ship without embedded subtitles, so the picker just showed "No subtitles" and there was no way to add them. This session wires OpenSubtitles REST API v1 as a fallback source that's merged into the existing picker.

**Source discriminator on `SubtitleTrack`.** Previously a single interface `{ index, fileName, language, ext }`; now a discriminated union in `@castcrate/shared`:
- `{ source: "torrent"; index; fileName; language; ext }` — unchanged shape apart from the added tag
- `{ source: "opensubtitles"; id: "os:<file_id>"; fileId; language; languageName; releaseName?; downloadCount? }`

Wire-format compatibility: the server always sets `source: "torrent"` on the pre-existing torrent-embedded shape, so no client-visible field shrunk. Every SubtitleTrack consumer (`Player`, `SubtitlePicker`, `CastBar`) was updated to branch on `source`.

**TrackId namespacing.** With two subtitle sources sharing the same `activeTrackIds` array on Chromecast, we needed non-colliding integer id ranges:
- Torrent tracks: `index + 1` (typical 1..20) — unchanged, preserves the pre-existing convention where 0 is avoided because some Chromecast firmware treats it as "no active track"
- OpenSubtitles tracks: `10_000 + offset` where offset is the track's position in the OS result list

The choice of "position in OS result list" (rather than a hash of file_id) keeps the numbers small and human-readable in logs. The OS cache TTL is 1h, so ordering is stable across a cast session lifetime. If we ever exceed 10_000 torrent-embedded tracks in a single release we have bigger problems.

The convention lives in `apps/server/src/routes/cast.ts` (`OS_TRACK_ID_BASE`, `trackIdForSubtitle`) and is mirrored in `apps/web/src/components/SubtitlePicker.tsx`.

**Endpoint shape.**
- `GET /stream/:infoHash/subtitles?imdbId=tt1234567` — merged list (torrent + OS). No breaking change to existing callers (the query param is optional).
- `GET /api/subtitles/opensubtitles/:fileId` — body endpoint for OS-sourced content. Accepts either `123` or `os:123` in the path. Returns `text/vtt; charset=utf-8` with CORS `*` (same as the torrent-embedded path). SRT→VTT conversion reuses `lib/srt.ts`.

**Disk cache for downloaded SRTs.** Free-tier OpenSubtitles allows 5 downloads/day per API key. To avoid burning that quota on repeat plays we cache each downloaded SRT to `<downloadPath>/.opensubtitles/<file_id>.srt`. Kept forever — files are small, few per movie. Directory is created lazily on first fetch so machines without OpenSubtitles configured don't get an extra mkdir at boot.

**Rate-limit / TOS gotchas worth noting.**
- Both `Api-Key` and `User-Agent: CastCrate/1.0` headers are required by OS TOS — omitting either yields 403.
- 429 / 406 responses are surfaced as an LRU miss + thrown from `/download`; searches quietly return `[]`. No exponential backoff — future work.
- Downloaded links from OS are temporary (~5 minute lifetime). We stream once and persist — subsequent plays never re-hit the API.
- OS's search endpoint is separate quota from `/download`; search alone doesn't consume download credits.
- Free tier documentation says 5 downloads/day; users heavier than that need a paid tier or their own key rotation.

**Config surface.**
- `OPENSUBTITLES_API_KEY` (env) — required to enable the adapter. Absent → adapter is disabled, returns `[]` from search, throws 503 from body endpoint.
- `OPENSUBTITLES_LANGUAGES` (env, comma-separated ISO 639) — default `en`. Filters search results.
- Neither field surfaces in the Settings UI in this pass — env-only for simplicity. Add to the Settings form later if users want runtime toggling.

**Test coverage.** `apps/server/src/services/__tests__/opensubtitles.test.ts` — 12 cases across 4 describe blocks: disabled path (no API key → returns [] without fetching), happy path (parsed results, sort order, request URL, language filter, cache hit), error paths (HTTP 500, network error, 429), and download caching (disk-cache hit skips both fetches, quota exceeded surfaces "quota exceeded", invalid file id rejects at the boundary).

**Not tested here** (deferred to real-device pass):
- End-to-end cast start with an OpenSubtitles track set as initial-active
- Hot-swap between torrent and OS tracks mid-cast
- OS-only picker rendering (i.e. release with zero embedded subs — the primary user-observable win)

Verified: `pnpm --filter @castcrate/server build`, `pnpm --filter @castcrate/web build`, `pnpm --filter @castcrate/server test` (243/243). Test count delta 218 → 243 (+25 tests since prior session; +12 from this feature's new file, +13 from prior work).

## Epic Review Findings (2026-08-09)

- 🔗 **Subtitle picker is a no-op during active cast** — ~~spans subtitles ↔ cast-controls ↔ player-buffer-ux — enumerate tracks upfront + `editTracksInfo` preferred.~~ **Resolved 2026-08-09** — see gotcha above.
- 🔗 **Subtitle track has no fallback if torrent disappears mid-cast** — spans subtitles ↔ chromecast ↔ player-buffer-ux — Chromecast silently loses `/stream/:hash/subtitles/:idx` if torrent is removed; warn or pin. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 💳 **No encoding detection; language heuristic; WebTorrent priority not bumped** — non-UTF-8 renders as garbage; picker shows "No subtitles" for minutes. Add `chardet`+`iconv`; `file.select(1)` to bump priority. (See epic-overview.md → Tech Debt / Findings.)

_Recorded by /review-epic castcrate on 2026-08-09._
