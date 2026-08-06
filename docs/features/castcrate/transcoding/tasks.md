# transcoding — Tasks

**Last updated:** 2026-05-09
**Progress:** Implemented (limited scope) — retrospective

## Original implementation (completed)

- [x] `services/transcoder.ts` — `spawnTranscode()`, `checkFfmpeg()`
- [x] FFmpeg pipeline: libx264 veryfast + AAC stereo + fragmented MP4
- [x] Configurable bitrate (`TRANSCODE_BITRATE` env, default `5M`)
- [x] `/stream/:infoHash/transcoded` route with `Accept-Ranges: none`
- [x] Cleanup on client disconnect (`req.raw.on("close")`, SIGTERM → SIGKILL after 1.5s)
- [x] EPIPE swallowed on early ffmpeg exit
- [x] Stderr tail captured for logging
- [x] `/api/system/check` reports ffmpeg availability + version
- [x] Settings toggle (`SMOOTH_PLAYBACK_KEY` in localStorage)
- [x] Player picks `/stream` vs `/stream/transcoded` by toggle
- [x] CastControls disables seek + skip when `disableSeek = true`

## Future enhancements

### High priority
- [ ] Auto-transcode for HEVC (probe file codec or measured bitrate)
- [ ] Global ffmpeg subprocess registry + `onClose` hook to kill on server shutdown
- [ ] Re-check ffmpeg availability when "Smooth playback" toggles on

### Medium priority
- [ ] Graceful fallback to pass-through if ffmpeg exits before any bytes sent
- [ ] Per-torrent transcode override (UI)
- [ ] Adaptive bitrate based on peer bandwidth
- [ ] Surface ffmpeg stderr tail in `/api/system/check`

### Low priority
- [ ] Seek-during-transcode (requires HLS or DASH segment pipeline)
- [ ] Hardware-accelerated encoders (`h264_videotoolbox` on macOS)
- [ ] Audio passthrough when source is AAC stereo
- [ ] Vitest for codec-detection helper (when wired)
