# subtitles — Context

**Last updated:** 2026-08-09
**Status:** Implemented (retrospective doc)

## Status

- Side-loaded SRT/VTT only — no OpenSubtitles, no API
- SRT→VTT conversion via `lib/srt.ts` (well-tested)
- Browser `<track>` and Chromecast MediaTextTracks both work
- **Runtime track switching during an active cast: implemented (2026-08-09)** via `EDIT_TRACKS_INFO` — no reload, no playback interruption
- Subtitle picker polls track list at 3s until tracks appear

## Key files

- `apps/server/src/services/subtitles.ts` — discovery, language guessing, VTT delivery
- `apps/server/src/lib/srt.ts` — SRT→VTT
- `apps/server/src/routes/subtitles.ts` — list + body endpoints
- `apps/server/src/services/cast.ts` — MediaTextTrack wiring, `setActiveTracks()` (EDIT_TRACKS_INFO), `CastSessionNotFoundError` / `UnknownTrackIdError`
- `apps/server/src/routes/cast.ts` — LAN-IP subtitle URL, enumerate-upfront in `/api/cast/play`, `POST /api/cast/sessions/:id/tracks`
- `apps/web/src/components/SubtitlePicker.tsx`, `Player.tsx`, `CastBar.tsx`
- `apps/web/src/lib/api.ts` — `setCastActiveTracks`
- `packages/shared/src/index.ts` — `CastMediaTrack`, `SetActiveTracksRequest`
- `apps/server/src/lib/__tests__/srt.test.ts`

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
