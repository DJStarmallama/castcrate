# library-settings — Context

**Last updated:** 2026-05-09
**Status:** Implemented (retrospective doc)

## Status

- History file persists to `~/.castcrate/history.json`, 200-entry cap
- Active downloads read live from WebTorrent + `meta` map, polled at 2s
- Settings modal is mostly read-only (env-driven); only smooth-playback toggle is user-settable
- `history.test.ts` covers append/prepend/clear/cap

## Key files

- `apps/server/src/services/history.ts` — load/append/clear, 200-cap
- `apps/server/src/routes/history.ts` — GET, DELETE
- `apps/server/src/routes/torrents.ts:152-202` — list, delete (writes history)
- `apps/server/src/routes/health.ts:12-24` — `/api/system/check`
- `apps/server/src/lib/config.ts` — env settings
- `apps/web/src/components/Library.tsx`, `Settings.tsx`
- `apps/web/src/hooks/useLocalState.ts`

## Decisions

- **JSON file over SQLite.** One user, no concurrency, no migrations. JSON is easy to inspect manually.
- **Settings are env-driven.** Avoids persisting yet another file; user edits `.env` and restarts.
- **Smooth playback in localStorage, not server.** Per-browser preference; server doesn't need to know.
- **Remove ≠ delete on disk.** Phase 4 only removes from the WebTorrent client. Disk cleanup is a future option.
- **Cap at 200.** Arbitrary but sensible for a single-user history.

## Gotchas

- **Non-atomic writes.** `writeFile` on the JSON file mid-crash → corrupted history. Move to temp+rename when it bites.
- **Silent recovery.** Bad JSON → empty cache, no log. Hard to diagnose.
- **History only written on removal.** Cast-only sessions never appear. Plan said "on cast start"; code doesn't.
- **`meta` map leaks.** External torrent destruction leaves stale entries until restart.
- **Smooth-playback toggle survives ffmpeg uninstall.** UI happily allows it; server returns 503 on `/transcoded`.
- **No hot-reload of `.env`.** Edit + restart.
