# Feature: transcoding — Phase 6 (Retrospective)

**Status:** Implemented (limited scope — see gotchas)
**Documented:** 2026-05-09
**Phase:** 6

## Executive summary

Real-time FFmpeg pipeline that re-encodes the WebTorrent file to fragmented MP4 (H.264 + AAC stereo, capped at 5 Mbps) for Chromecast compatibility. Triggered by a browser-local "Smooth playback" toggle (`localStorage`) that switches the player from `/stream/:hash` to `/stream/:hash/transcoded`. The transcoded route streams stdin → ffmpeg → stdout → HTTP body. Range requests are explicitly disabled; seek-during-transcode is not supported.

The technical design originally described "auto-on for HEVC or >8 Mbps" — that codec-detection branch is not implemented. The toggle is purely user-controlled.

---

## Pipeline

```
Player.tsx
  reads SMOOTH_PLAYBACK_KEY from localStorage
  ┌────────────────────────────────────────────┐
  │ if smooth: GET /stream/:hash/transcoded    │
  │ else      : GET /stream/:hash              │
  └────────────────────────────────────────────┘
                  │
                  ▼
routes/torrents.ts:230-286  (transcoded route)
                  │
                  │  source = file.createReadStream()       ← WebTorrent file (full)
                  │  process = spawnTranscode(source)       ← services/transcoder.ts
                  │
                  ▼
ffmpeg pipe:0 ──[H.264/AAC fragmented MP4]──▶ pipe:1 ──▶ reply.send(stdout)

  reply.header("Accept-Ranges", "none")  ← clients see seek is unsupported
  req.raw.on("close", cleanup)           ← unpipe + SIGTERM/SIGKILL ffmpeg
```

## Key files

| Path | Role |
|---|---|
| `apps/server/src/services/transcoder.ts` | `spawnTranscode(source)`, `checkFfmpeg()` (binary detection, version cache) |
| `apps/server/src/routes/torrents.ts:230-286` | `/stream/:infoHash/transcoded` route, cleanup wiring |
| `apps/server/src/lib/config.ts` | `FFMPEG_PATH`, `TRANSCODE_BITRATE`, `TRANSCODE_BUFFER_PERCENT` |
| `apps/server/src/lib/quality.ts` | shared codec/resolution parser (used by indexers, not the runtime decision) |
| `apps/server/src/routes/health.ts` | `/api/system/check` — reports ffmpeg availability + version |
| `apps/web/src/components/Settings.tsx` | "Smooth playback" toggle, disabled if ffmpeg missing |
| `apps/web/src/components/Player.tsx:9-10,21,27` | route selection from `useLocalState(SMOOTH_PLAYBACK_KEY)` |
| `apps/web/src/components/CastControls.tsx` | `disableSeek={smooth}` prop, "seek disabled (transcoding)" hint |

## FFmpeg invocation

```
ffmpeg \
  -hide_banner -loglevel error \
  -i pipe:0 \
  -c:v libx264 -preset veryfast \
  -b:v 5M -maxrate 5M -bufsize 10M \
  -pix_fmt yuv420p \
  -c:a aac -b:a 192k -ac 2 \
  -movflags frag_keyframe+empty_moov+default_base_moof \
  -f mp4 pipe:1
```

| Flag | Why |
|---|---|
| `libx264 + veryfast` | H.264 reliable on all Chromecast generations; preset trades quality for laptop CPU |
| `-b:v 5M -maxrate 5M -bufsize 10M` | Bitrate cap; 2x bufsize to keep VBV happy without spikes |
| `-pix_fmt yuv420p` | 4:2:0 chroma — standard, cheaper, broadly supported |
| `-c:a aac -b:a 192k -ac 2` | DefaultMediaReceiver wants AAC stereo; no 5.1 |
| `frag_keyframe+empty_moov+default_base_moof` | Fragmented MP4 — `moov` first, each fragment self-contained, no seek-back to write metadata |
| `-i pipe:0 -f mp4 pipe:1` | stdin from torrent file, stdout to HTTP body — no temp files |

`TRANSCODE_BITRATE` env can override `5M` (also adjusts `maxrate`/`bufsize` accordingly).

## Lifecycle

- **Spawn.** `spawn(config.ffmpegPath, args)` per request.
- **Source pipe.** `source.pipe(process.stdin).on("error", () => {})` — EPIPE swallowed silently if ffmpeg exits early.
- **Stderr.** Last 4KB captured for logging; non-zero exit logs the tail.
- **Cleanup.** `req.raw.on("close", cleanup)` fires on client disconnect or stream end. `cleanup()` unpipes the source and `process.kill("SIGTERM")`; if still alive after 1.5s, `SIGKILL`.
- **No global tracking.** Per-request only — there's no Fastify `onClose` registration. If the server is killed mid-stream, ffmpeg orphans.
- **No retry / fallback.** If ffmpeg crashes mid-stream, the client sees truncated/garbled video. There's no automatic downgrade to pass-through.

## Codec detection

**Two layers, only one is wired:**

1. **At indexer time** (`services/{yts,eztv,knaben}.ts`): magnet titles parsed for `x264`/`x265`/`hevc`/`xvid`/`av1`. `castFriendly: true` only for x264. This drives **filtering and ranking**, not auto-transcode.
2. **At stream time**: not implemented. The route does **not** probe the actual file codec, does not check bitrate, and does not auto-enable transcode for HEVC. The user toggle is the only signal.

Effect: HEVC torrents that slip past the indexer filter won't auto-transcode. The user has to manually toggle "Smooth playback" and accept the no-seek restriction.

## Range / seek behaviour

- `/stream/:hash` — full byte-range support (Phase 2).
- `/stream/:hash/transcoded` — `Accept-Ranges: none`. Browser HTML5 video respects this; seek bar disabled in CastControls (`disableSeek={smooth}`); skip ±10s buttons disabled.
- This is documented in `docs/technical-design.md` §5 and reinforced by UI ("seek disabled (transcoding)" hint in `CastControls.tsx:74`).

## Tests

None for `transcoder.ts`. Codec parsing in `quality.ts` is exercised indirectly by the indexer tests. Transcode is integration-only — needs a real ffmpeg binary and a real video file.

---

## Gotchas

- **No auto-transcode for HEVC.** Plan/design said "forced on for HEVC or >8 Mbps"; only user toggle is wired. If a non-x264 file slips through (it shouldn't post-Phase 5 filters), the user has to flip the toggle manually.
- **Orphaned ffmpeg on server crash.** No `onClose` hook destroys live transcode subprocesses. Restart leaves zombies. `pkill ffmpeg` is the workaround.
- **No fallback on ffmpeg failure.** If ffmpeg exits non-zero mid-stream, the HTTP body is truncated — client sees broken video, not a re-attempt or a downgrade.
- **`checkFfmpeg()` caches forever.** First detection result is cached for the process lifetime. If the user installs ffmpeg mid-session, restart is required.
- **Smooth-playback toggle survives ffmpeg uninstall.** UI doesn't re-check on toggle; user flips on, gets 503 from `/transcoded`, no clear feedback.
- **Single bitrate cap.** No adaptive bitrate, no per-torrent override, no client-bandwidth detection. 5 Mbps is conservative for 1080p but can soften in some scenes.
- **Audio is forced stereo.** 5.1 source → downmix. No way to opt out for audio-only purists.
- **EPIPE silently swallowed.** Could mask actual pipe errors; debugging requires checking stderr tail.

## Future enhancements

### High priority
- [ ] Auto-transcode trigger based on file codec probe (HEVC, AV1) or measured bitrate
- [ ] Server-side `onClose` hook to kill all live ffmpeg subprocesses on shutdown
- [ ] Re-check ffmpeg availability when smooth-playback toggle flips on

### Medium priority
- [ ] Graceful fallback to pass-through if ffmpeg fails before any bytes are sent
- [ ] Per-torrent transcode override (UI option)
- [ ] Adaptive bitrate based on observed peer bandwidth
- [ ] Surface ffmpeg error tail in `/api/system/check` for debugging

### Low priority
- [ ] Seek-during-transcode (requires segment-based pipeline — significant rework)
- [ ] Hardware-accelerated encoders (`h264_videotoolbox` on macOS)
- [ ] Audio passthrough when source is already AAC stereo
