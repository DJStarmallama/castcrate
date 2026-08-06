# library-settings — Tasks

**Last updated:** 2026-05-09
**Progress:** Implemented (retrospective)

## Original implementation (completed)

- [x] `services/history.ts` — file-backed array, 200-cap, prepend (newest first)
- [x] `routes/history.ts` — GET, DELETE
- [x] `DELETE /api/torrent/:hash` writes history with `completed = status.done`
- [x] `GET /api/torrents` — joins live WebTorrent state with `meta` map
- [x] `GET /api/system/check` — env + ffmpeg state for Settings UI
- [x] `Library.tsx` — Active downloads + History tabs
- [x] `Settings.tsx` — system check + smooth-playback toggle
- [x] `useLocalState` hook for `castcrate.smoothPlayback`
- [x] `Player.tsx` chooses `/stream` vs `/stream/transcoded` from local state
- [x] Vitest for `history.ts` (append/prepend/clear/cap)

## Future enhancements

### High priority
- [ ] Atomic writes for `history.json` (temp file + rename)
- [ ] Write history on cast start, not just torrent removal
- [ ] "Delete files on disk?" prompt when removing an active torrent

### Medium priority
- [ ] Editable server settings (PATCH `/api/settings` → `~/.castcrate/settings.json`)
- [ ] `MAX_CONCURRENT` cap + download queue
- [ ] Search / filter on history
- [ ] Re-check ffmpeg availability on smooth-playback toggle

### Low priority
- [ ] Resume in-progress torrents from `meta` snapshot on restart
- [ ] Export history (CSV/JSON)
- [ ] Per-entry history removal
- [ ] Race-condition test for concurrent `appendHistory` calls
- [ ] Corrupted-JSON recovery test
