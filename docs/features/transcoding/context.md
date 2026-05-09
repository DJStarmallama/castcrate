# transcoding — Context

**Last updated:** 2026-05-09
**Status:** Implemented (limited scope) — retrospective doc

## Status

- FFmpeg pipeline H.264 + AAC stereo, capped at 5 Mbps
- Triggered only by user "Smooth playback" toggle (localStorage)
- Range requests disabled on `/stream/:hash/transcoded`
- No tests; integration-only

## Key files

- `apps/server/src/services/transcoder.ts` — `spawnTranscode`, `checkFfmpeg`
- `apps/server/src/routes/torrents.ts:230-286` — transcoded route + cleanup
- `apps/server/src/lib/config.ts` — `FFMPEG_PATH`, `TRANSCODE_BITRATE`, `TRANSCODE_BUFFER_PERCENT`
- `apps/server/src/routes/health.ts` — ffmpeg availability surface
- `apps/web/src/components/Settings.tsx` — toggle UI
- `apps/web/src/components/Player.tsx:9-10,21,27` — URL selection
- `apps/web/src/components/CastControls.tsx` — `disableSeek` hint

## Decisions

- **Pipe in, pipe out.** No temp files; stdin from `file.createReadStream()`, stdout to HTTP response.
- **5 Mbps cap.** Conservative for older Chromecasts; configurable via env.
- **Fragmented MP4.** `frag_keyframe+empty_moov+default_base_moof` — moov first, no seek-back, each fragment self-contained.
- **AAC stereo only.** DefaultMediaReceiver requires it; no 5.1 path.
- **Per-request subprocess, per-request cleanup.** No pooling. Simpler shutdown.
- **`Accept-Ranges: none`.** No seek pretence. Disables the seek bar via UI.
- **User-controlled toggle, not codec-driven.** Plan said auto-on for HEVC; reality is manual.

## Gotchas

- **HEVC files don't auto-transcode.** Code is missing the codec probe; user must toggle.
- **Orphaned ffmpeg on server crash.** No global cleanup; restart leaves zombies.
- **`checkFfmpeg()` cache is process-lifetime.** Install/uninstall mid-session requires restart.
- **EPIPE swallowed silently** — masks debugging clues.
- **Smooth toggle stays on if ffmpeg uninstalled.** No re-check on toggle.
- **No fallback.** ffmpeg fails mid-stream → broken video; no re-attempt.
