# Feature: subtitles — Phase 8 (Retrospective)

**Status:** Implemented
**Documented:** 2026-05-09
**Phase:** 8

## Executive summary

Side-loaded subtitles only — no OpenSubtitles, no API. Any `.srt` or `.vtt` file in the torrent's file list is exposed as a track. SRT is converted to WebVTT on the fly (`lib/srt.ts`) and served with `Access-Control-Allow-Origin: *` so the Chromecast (and dev proxy) can fetch it. Playback wires the chosen track into both `<track>` for in-browser and `MediaTextTrack[]` for Cast V2.

`lib/srt.ts` does the only nontrivial parsing: BOM strip, CRLF→LF, comma→dot in timestamps, prepend `WEBVTT` header. Cue text is preserved verbatim — commas in dialogue are not touched.

---

## Architecture

```
WebTorrent file list
  │ filter *.srt / *.vtt → discoverSubtitles(infoHash)
  ▼
GET /stream/:infoHash/subtitles
  → { tracks: [{ index, fileName, language, ext }] }   (no cache, polled at 3s)

User picks → SubtitlePicker.tsx state
  ↓
in-browser <video>:
  <track kind="subtitles" src="/stream/:hash/subtitles/:idx" label={lang} default>

cast:
  POST /api/cast/play with subtitlePath, subtitleLanguage, subtitleName
  ↓
routes/cast.ts builds full URL: http://<lan-ip>:3000/stream/.../subtitles/:idx
  ↓
cast.ts MediaInfo.tracks = [{ trackId: 1, type: "TEXT", subtype: "SUBTITLES", trackContentId: url, trackContentType: "text/vtt", name, language }]
  activeTrackIds: [1]

GET /stream/:infoHash/subtitles/:idx
  → text/vtt; charset=utf-8 (CORS *)
  → SRT? srtToVtt(buffer) ; VTT? pass-through
```

## Key files

| Path | Role |
|---|---|
| `apps/server/src/services/subtitles.ts` | discovery, language guessing, VTT delivery |
| `apps/server/src/lib/srt.ts` | `srtToVtt(srt: string): string` — BOM strip, CRLF→LF, `,` → `.` in timestamps, WEBVTT header |
| `apps/server/src/routes/subtitles.ts` | `GET /stream/:hash/subtitles` (list), `GET /stream/:hash/subtitles/:idx` (one track) |
| `apps/server/src/services/cast.ts:110-136` | passes `tracks` + `activeTrackIds: [1]` in `MediaInfo` |
| `apps/server/src/routes/cast.ts:69-77` | constructs full subtitle URL with LAN IP |
| `apps/web/src/components/SubtitlePicker.tsx` | dropdown, polls list at 3s until tracks appear |
| `apps/web/src/components/Player.tsx:145-161` | `<track>` element with `default` and re-key on change |
| `apps/web/src/components/CastBar.tsx` | passes selected subtitle to play mutation |
| `apps/web/src/lib/api.ts` | `subtitles(infoHash)` |
| `apps/server/src/lib/__tests__/srt.test.ts` | 6 cases — header, comma→dot, CRLF, BOM, multi-cue, dialogue commas |

## Discovery (`services/subtitles.ts`)

- Iterates `torrent.files` for the given infoHash, filters by `/\.(srt|vtt)$/i`.
- Returns `[{ index, fileName, language, ext }]`.
- Language guess (`guessLanguage`): split filename into `.`/`-`/`_`-delimited tokens, match against an ISO 639 lookup (`en`, `eng`, `english` → "English", etc.). Fallback string: `"Subtitles"`.
- No caching — runs on every `GET /stream/:hash/subtitles`. Rare to have hundreds of files in one torrent, so acceptable.

## Endpoints

| Method | Path | Behaviour |
|---|---|---|
| GET | `/stream/:hash/subtitles` | JSON track list. `Cache-Control: no-store`. |
| GET | `/stream/:hash/subtitles/:idx` | Track body as `text/vtt; charset=utf-8`. SRT → VTT via `srtToVtt(buffer)`. VTT → pass-through. `Access-Control-Allow-Origin: *`. 404 if torrent or index invalid. |

CORS is permissive on the body endpoint because the Chromecast fetches the URL and (in dev) the Vite proxy may rewrite origins.

## SRT → VTT conversion (`lib/srt.ts`)

| Step | What it does |
|---|---|
| BOM strip | Removes `﻿` prefix (Windows tools sometimes add it) |
| Line endings | `\r\n` and `\r` → `\n` |
| Timestamp format | `00:00:01,234 --> 00:00:02,345` → `00:00:01.234 --> 00:00:02.345` (only the millisecond comma) |
| Header | Prepends `WEBVTT\n\n` |
| Whitespace | Strips leading/trailing blank lines |

Cue IDs, cue text, line breaks within cues — all preserved unchanged. Tested in `srt.test.ts`.

## Browser playback

```jsx
<video autoPlay controls key={subtitle?.index ?? "none"} ...>
  <source src={playUrl} ... />
  {subtitle && (
    <track
      kind="subtitles"
      src={`/stream/${session.infoHash}/subtitles/${subtitle.index}`}
      label={subtitle.language}
      default
    />
  )}
</video>
```

The `<video>` is re-keyed on subtitle change so the browser re-parses the track list. Without re-key, browsers cache the previous `<track>` selection and refuse to switch.

## Chromecast playback

`cast.ts.play()` passes:

```ts
tracks: params.tracks?.map((t, i) => ({
  trackId: i + 1,
  type: "TEXT",
  trackContentId: t.url,            // full http://lan-ip URL
  trackContentType: "text/vtt",
  name: t.language,
  language: t.language,
  subtype: "SUBTITLES",             // not "CAPTIONS"
})),
activeTrackIds: [1],
```

URL must be the LAN-IP form, not `localhost`, so `routes/cast.ts` builds it via `getLanIp()`. Only the first track is active; runtime switching would need `Media.editTracksInfo` (not wired).

## Web UI

- **SubtitlePicker.** Polls `subtitles(infoHash)` every 3s until tracks appear (gives WebTorrent time to finish downloading subtitle files), then settles. Lists "Off" + each language; checkmark on the selected one.
- **CastBar.** When the user is casting, the picker's state flows into the play mutation as `subtitlePath` + `subtitleLanguage` + `subtitleName`.
- **Player.** Holds `subtitle` state locally; passes it down to both the `<track>` (in-browser) and CastBar (cast).

## Tests

- `lib/__tests__/srt.test.ts` — 6 cases covering header, timestamp comma→dot, CRLF→LF, BOM strip, multi-cue preservation, dialogue commas left alone.
- `services/subtitles.ts._internals.guessLanguage` is exported but not tested.
- No integration tests for the discovery → play flow.

---

## Gotchas

- **No persistence between starts.** Each torrent's subtitle list is rediscovered on every request — fine for now, but a 200-file torrent would be slow.
- **Language guessing is heuristic.** `Movie.eng.srt` → "English", `subs/01.srt` → "Subtitles". Ambiguous filenames degrade to the fallback.
- **Single track active on Chromecast.** Cast SDK supports more, but the wire format only sends `activeTrackIds: [1]`.
- **CORS is `*`.** Permissive — fine on a LAN, but any web page in the same browser can read subtitle files. Tighten if you ever proxy through a domain.
- **No encoding fallback.** Non-UTF-8 SRT (cp1252 / Latin-1) yields garbage. No `chardet` or `iconv` round-trip.
- **No cue styling.** Plain text only — colours, positioning, italics from SRT/VTT styling are dropped if the parser doesn't preserve them, and Chromecast styling APIs aren't exposed.
- **Subtitle file priority not bumped.** `file.select(1)` could speed download of selected subtitles but isn't called; the user sees "no tracks" until WebTorrent's internal scheduler reaches the file.
- **VTT line endings are LF.** Some old Chromecast firmware reportedly preferred CRLF — not currently re-emitted.
- **No multi-track switching at runtime.** Stop + replay to change.

## Future enhancements

### High priority
- [ ] Bump priority of selected subtitle file (`file.select(1)`) so it downloads quickly
- [ ] Encoding detection fallback (chardet → iconv) for non-UTF-8 SRT

### Medium priority
- [ ] Per-torrent cache of discovered tracks (avoid re-scanning on every request)
- [ ] Multi-track Chromecast switching (`Media.editTracksInfo`)
- [ ] OpenSubtitles fallback when none are bundled in the torrent
- [ ] Tighten CORS once web origin is stable

### Low priority
- [ ] Cue styling preservation (italics, positioning)
- [ ] CRLF emission option for legacy Chromecast firmware
- [ ] Vitest for `guessLanguage` heuristic
- [ ] User-uploaded subtitle file via drag-and-drop
