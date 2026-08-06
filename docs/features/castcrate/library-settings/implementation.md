# Feature: library-settings — Phase 4 (Retrospective)

**Status:** Implemented
**Documented:** 2026-05-09
**Phase:** 4

## Executive summary

Two-tab modal for active downloads + watch history, plus a settings panel. History is persisted to `~/.castcrate/history.json` (one user, no concurrency). Active downloads are read live from the WebTorrent client and decorated with the `meta` map. Most settings are env-driven and read-only; the only client-side setting is "Smooth playback" (transcode toggle, Phase 6) stored in `localStorage`.

The history file is the only persistent state in the app.

---

## Architecture

```
Library modal
├── Active downloads ── GET /api/torrents (poll 2000ms) ──▶ services/torrent.ts.listActiveTorrents()
│                                                            └── joins meta map (title, poster, resolution)
└── History           ── GET /api/history ────────────────▶ services/history.ts (cached array, file-backed)

DELETE /api/torrent/:hash ──▶ removeTorrent() ──▶ appendHistory({ ...meta, completed, endedAt })
DELETE /api/history       ──▶ clearHistory() (rewrites empty array)

Settings modal
├── server settings ── GET /api/system/check (env + ffmpeg detection)
└── client settings ── localStorage("castcrate.smoothPlayback")
```

## Key files

| Path | Role |
|---|---|
| `apps/server/src/services/history.ts` | in-memory cached array, write-through to `~/.castcrate/history.json`, 200-entry cap |
| `apps/server/src/routes/history.ts` | `GET /api/history`, `DELETE /api/history` |
| `apps/server/src/routes/torrents.ts:152-202` | `GET /api/torrents`, `DELETE /api/torrent/:hash` (writes history on remove) |
| `apps/server/src/routes/health.ts:12-24` | `GET /api/system/check` — config snapshot + ffmpeg state |
| `apps/server/src/lib/config.ts` | env-driven settings (download path, buffer thresholds, transcode bitrate, ffmpeg path) |
| `apps/server/src/services/__tests__/history.test.ts` | unit tests (empty start, append, prepend order, clear, 200-cap) |
| `apps/web/src/components/Library.tsx` | modal — active + history tabs |
| `apps/web/src/components/Settings.tsx` | modal — system check display + smooth-playback toggle |
| `apps/web/src/hooks/useLocalState.ts` | `useState` mirrored to `localStorage` |
| `apps/web/src/components/Player.tsx:9-10,21,27` | reads `SMOOTH_PLAYBACK_KEY` to choose `/stream` vs `/stream/transcoded` |

## History (`services/history.ts`)

- **File.** `~/.castcrate/history.json` — single JSON array, pretty-printed (2-space indent).
- **Schema (`HistoryEntry`).** `{ id, title, posterUrl, imdbId, resolution, videoName, startedAt, endedAt, completed }`.
- **Write strategy.** Read entire file → cache → mutate in memory → `writeFile` whole. **Not atomic** (no temp + rename), no `fsync`. Crash mid-write can corrupt.
- **Cap.** 200 entries (newest first; oldest dropped).
- **Triggers.**
  1. `POST /api/torrent/start` → only `setMeta()` (no history write yet).
  2. `DELETE /api/torrent/:hash` → `appendHistory()` with `completed = status.done`.
  3. `DELETE /api/history` → clears.
- **Recovery.** Missing or unreadable file → silent fallback to `[]`. No logging.

## Active downloads

- `GET /api/torrents` enumerates `client.torrents` (live WebTorrent state) and joins the in-memory `meta` map (title, poster, resolution from start time).
- UI polls at 2000ms (TanStack Query `refetchInterval`).
- "Remove" button → `DELETE /api/torrent/:hash`. Stops seeding/downloading, deletes from `meta`, appends history. **Does not delete files from disk** — the user keeps the partial download.

## Settings

- **Server settings (read-only in UI).** `DOWNLOAD_PATH`, `BUFFER_PERCENT`, `TRANSCODE_BUFFER_PERCENT`, `TRANSCODE_BITRATE`, `FFMPEG_PATH`, `OMDB_API_KEY` (presence only). Surface via `/api/system/check`. No hot reload.
- **Client setting.** `castcrate.smoothPlayback` boolean in `localStorage`, controlled by toggle in `Settings.tsx`. Disabled when ffmpeg is not detected. Read by `Player.tsx` to choose stream URL.
- **`/api/system/check` response.** `{ omdbConfigured, ffmpegAvailable, ffmpegVersion, downloadPath, bufferPercent, transcodeBufferPercent, transcodeBitrate, ... }`.

## Tests

`history.test.ts` covers the pure-data behaviour: empty start, append + prepend order, clear, 200-cap. No tests for:
- DELETE → history-append integration
- Concurrent `appendHistory` races
- Corrupted JSON recovery
- `useLocalState` persistence
- `/api/system/check` response shape

---

## Gotchas

- **No atomic writes.** Crash during `writeFile` corrupts `history.json`. Use a temp file + rename if this ever bites.
- **Silent fallback on read errors.** Malformed JSON or missing file → `cache = []`. Logged log of nothing — debugging is opaque.
- **`meta` map can leak.** If a torrent is destroyed externally (process kill, OOM), the entry stays in `meta` until restart.
- **History is only written on removal.** Technical-design says "on cast start, append" but the code doesn't — entries appear only when the user explicitly removes a torrent. Cast-only sessions (no removal) leave no record.
- **Settings are not hot-reloadable.** `.env` change → server restart.
- **`MAX_CONCURRENT` is not implemented.** Mentioned in plans, not in config.
- **Smooth playback toggle is allow-while-ffmpeg-once-detected.** If ffmpeg is uninstalled mid-session the toggle still appears enabled; transcoded stream returns 503.
- **Deleting active torrent does NOT delete files on disk.** Intentional in v1, but the UI doesn't make this clear.

## Future enhancements

### High priority
- [ ] Atomic writes (`writeFile(temp)` + `rename`) for `history.json`
- [ ] Append history on cast start, not just on torrent removal
- [ ] Surface "Delete files on disk?" prompt when removing an active torrent

### Medium priority
- [ ] Editable settings (PATCH `/api/settings` writing to `~/.castcrate/settings.json`)
- [ ] Concurrent-download cap (`MAX_CONCURRENT`) with queue
- [ ] Search/filter on history (by title, by date)
- [ ] Re-check ffmpeg availability when user toggles smooth playback

### Low priority
- [ ] Resume in-progress torrents on server restart from `meta` snapshot
- [ ] Export history (CSV, JSON)
- [ ] Per-entry "remove from history" button
