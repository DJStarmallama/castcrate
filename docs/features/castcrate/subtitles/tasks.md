# subtitles — Tasks

**Last updated:** 2026-05-09
**Progress:** Implemented (retrospective)

## Original implementation (completed)

- [x] `services/subtitles.ts` — discover SRT/VTT in torrent file list, guess language
- [x] `lib/srt.ts` — SRT→VTT (BOM, CRLF→LF, comma→dot, WEBVTT header)
- [x] Routes: `GET /stream/:hash/subtitles`, `GET /stream/:hash/subtitles/:idx`
- [x] CORS `*` on subtitle body for Chromecast + dev proxy
- [x] In-browser `<track kind="subtitles" default>` + re-key on change
- [x] Cast: MediaTextTrack[] passed in MediaInfo, `activeTrackIds: [1]`
- [x] LAN-IP URL constructed in `routes/cast.ts` for subtitle path
- [x] SubtitlePicker — polls list at 3s until tracks appear
- [x] CastBar passes selected subtitle into play mutation
- [x] Vitest for `srt.ts` (6 cases)

## Future enhancements

### High priority
- [ ] Bump WebTorrent priority for selected subtitle file (`file.select(1)`)
- [ ] Encoding detection fallback (chardet → iconv) for non-UTF-8 SRT

### Medium priority
- [ ] Per-torrent cache of discovered tracks
- [x] Multi-track switching at runtime via `Media.editTracksInfo` — done 2026-08-09 (see `context.md` "Session notes"). Torrent sessions only; HTTP-stream (Stremio) sessions still require stop+replay.
- [ ] OpenSubtitles fallback when no subs are bundled
- [ ] Tighten CORS to known origins once a stable web origin exists

### Low priority
- [ ] Preserve cue styling (italics, positioning, colours)
- [ ] Optional CRLF emission for legacy Chromecast firmware
- [ ] Vitest for `guessLanguage` heuristic
- [ ] User-upload via drag-and-drop
