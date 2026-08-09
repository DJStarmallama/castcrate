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
- **Subtitle picker is a no-op during an active cast session.** `SubtitlePicker.onSelect` only sets local React state, which drives the local `<video>`'s `<track>`. The Chromecast session was configured with its subtitle (or none) at `castPlay` time and there's no route to change it mid-flight. **Options for the fix:**
  1. **Enumerate all tracks upfront** at cast start, pass them all to the receiver, then swap `activeTrackIds` via `EDIT_TRACKS_INFO` message (no restart, no blip). Requires the tracks to exist on disk before cast start; today only the one selected in the picker is passed.
  2. **Reload the media** with the new subtitle (uses existing `load()` codepath). Simple, but causes a brief playback interruption + loses seek position unless we re-seek immediately.
  Wiring: SubtitlePicker needs to know about `castSessionId`; when set, call a new `POST /api/cast/sessions/:id/subtitle` instead of just setting local state. Reported by user during `castcrate/media-mac-deploy` P6.4 cast test — "Wish I could trigger subtitles whilst its casting."

## Epic Review Findings (2026-08-09)

- 🔗 **Subtitle picker is a no-op during active cast** — spans subtitles ↔ cast-controls ↔ player-buffer-ux — enumerate tracks upfront + `editTracksInfo` preferred. Blocks cast completeness. `/review-feature castcrate/subtitles`. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Subtitle track has no fallback if torrent disappears mid-cast** — spans subtitles ↔ chromecast ↔ player-buffer-ux — Chromecast silently loses `/stream/:hash/subtitles/:idx` if torrent is removed; warn or pin. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 💳 **No encoding detection; language heuristic; WebTorrent priority not bumped** — non-UTF-8 renders as garbage; picker shows "No subtitles" for minutes. Add `chardet`+`iconv`; `file.select(1)` to bump priority. (See epic-overview.md → Tech Debt / Findings.)

_Recorded by /review-epic castcrate on 2026-08-09._
