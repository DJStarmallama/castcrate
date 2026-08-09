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

## Epic Review Findings (2026-08-09)

- 🔗 **Stremio HTTP-stream sessions bypass history entirely** — spans stremio-addon-source ↔ library-settings ↔ transcoding — Real-Debrid streams return `infoHash: null` and `setMeta()` is skipped; cast-play's `infoHashFromStreamPath()` returns null so nothing appends. Decide: synthetic-id history OR surface the tier explicitly. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **`@castcrate/shared` doesn't mark read-only vs writable settings** — spans library-settings ↔ every feature reading `RuntimeSettings` — no type-level guard against wiring a computed field as PATCH-able. Split into `RuntimeSettingsReadable` and `RuntimeSettingsWritable`. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **mkdirSync-at-module-load** — spans scaffold ↔ yts-streaming ↔ library-settings ↔ transcoding — same deploy-time boot-fragility class of bug. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Torrent-lifecycle idempotency was implicit and untested (the recent crash proved it)** — spans yts-streaming ↔ library-settings ↔ transcoding ↔ player-buffer-ux — add `services/__tests__/torrent.test.ts` for double-delete; annotate DELETE route "Idempotent. Safe to retry." (See epic-overview.md → Tech Debt / Findings for full detail.)
- 💳 **History writes non-atomic; `meta` map can leak; cast-only sessions leave no trace** — write is `writeFile()` not temp+rename; nothing clears `meta` on external kill; history only appends on removal. Land in `hardening` Phase B. (See epic-overview.md → Tech Debt / Findings.)

_Recorded by /review-epic castcrate on 2026-08-09._
