# subtitles — Context

**Last updated:** 2026-05-09
**Status:** Implemented (retrospective doc)

## Status

- Side-loaded SRT/VTT only — no OpenSubtitles, no API
- SRT→VTT conversion via `lib/srt.ts` (well-tested)
- Browser `<track>` and Chromecast MediaTextTracks both work
- Single active track per cast session
- Subtitle picker polls track list at 3s until tracks appear

## Key files

- `apps/server/src/services/subtitles.ts` — discovery, language guessing, VTT delivery
- `apps/server/src/lib/srt.ts` — SRT→VTT
- `apps/server/src/routes/subtitles.ts` — list + body endpoints
- `apps/server/src/services/cast.ts:110-136` — MediaTextTrack wiring
- `apps/server/src/routes/cast.ts:69-77` — LAN-IP subtitle URL
- `apps/web/src/components/SubtitlePicker.tsx`, `Player.tsx:145-161`, `CastBar.tsx`
- `apps/server/src/lib/__tests__/srt.test.ts`

## Decisions

- **No external API.** Side-loaded only. Avoids OpenSubtitles auth + rate limits + legal grey area.
- **SRT→VTT on demand, not pre-converted.** Cheap; lets us handle weird encodings centrally.
- **CORS `*`.** Chromecast fetches the URL; dev proxy may rewrite origins. LAN-only, low risk.
- **Re-key the `<video>` on subtitle change.** Browsers cache `<track>` aggressively; re-key forces re-parse.
- **Single active track on Chromecast.** Cast SDK supports more; we don't expose track switching.
- **`activeTrackIds: [1]`.** First track always activated.

## Gotchas

- **No encoding detection.** Non-UTF-8 SRT yields garbage. Add chardet+iconv if it bites.
- **Language heuristic is filename-based.** Ambiguous → "Subtitles".
- **No cache.** Track list is recomputed per request; fine for normal torrents, slow for 200-file torrents.
- **CORS `*` is permissive.** Tighten if you ever serve from a real domain.
- **Subtitle file isn't priority-bumped** in WebTorrent — user sees "no tracks" until normal download reaches it.
- **No runtime multi-track switching.** Stop + replay to change.
- **VTT line endings are LF.** Some legacy Chromecast firmware prefers CRLF.
