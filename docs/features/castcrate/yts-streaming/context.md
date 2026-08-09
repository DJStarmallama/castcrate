# yts-streaming — Context

**Last updated:** 2026-08-09
**Status:** Implemented (retrospective doc)

## 2026-08-09 — IndexerAdapter registration

- `services/yts.ts` now exports `ytsAdapter: IndexerAdapter` at the bottom of the file (`name: "yts"`, `supportsMovie: true`).
- `routes/torrents.ts` registers it as the first entry in `movieChain` and calls the shared `runFallback()` from `lib/indexers.ts` — the inline `if (settings.sourceEnabled.yts) { tried.push("yts"); ... }` code is gone.
- `searchTorrents()` function export is unchanged; existing tests keep working.

## Status

- YTS → WebTorrent → byte-range → `<video>` works end-to-end
- Status polled at 1500ms; no WebSocket
- Phase 2 only deletes torrents from the client; on-disk file deletion came later
- `range.ts` and `yts.ts` are unit-tested

## Key files

- `apps/server/src/services/yts.ts` — adapter, LRU cache, ranking, magnet builder
- `apps/server/src/services/torrent.ts` — WebTorrent singleton, `pickVideoFile`, meta map
- `apps/server/src/lib/range.ts` — `bytes=start-end`, suffix, open-ended
- `apps/server/src/routes/torrents.ts` — search, start, status, list, stream, delete
- `apps/web/src/components/TorrentPicker.tsx`, `Player.tsx`
- `apps/web/src/lib/api.ts` — `searchTorrents`, `startTorrent`, `torrentStatus`, `removeTorrent`
- `apps/server/src/services/__tests__/yts.test.ts`, `apps/server/src/lib/__tests__/range.test.ts`

## Decisions

- **Filter to 1080p/720p × x264/h264.** Sidesteps Chromecast HEVC support fragility for v1. Other codecs require Phase 6 transcoding.
- **`pickVideoFile` = largest by size.** Simple heuristic; works for movies, fails for season packs (Phase 5 still relies on this).
- **WebTorrent singleton.** One client per server, multiple torrents in parallel. No bandwidth cap.
- **Polling, not WebSocket.** WebSocket plugin registered in Phase 3 (mainly for cast state); polling is fine for torrent stats.
- **Indexer adapter pattern.** `TorrentResult` is the shared shape; new indexers drop in as new files in `services/`. No premature abstraction until 5+ exist.

## Gotchas

- **Sequential mode is implicit, not asserted.** `client.add` doesn't pass `{ sequentialDownload: true }` — relies on WebTorrent defaults. Document and/or fix.
- **Pre-buffer reads block.** No timeout; browser eventually gives up. UX gap.
- **`pickVideoFile` season-pack behaviour.** Largest file wins, which is rarely the right episode.
- **StrictMode double-mount.** `Player.tsx` cleans up via explicit `handleClose`, not effect cleanup. Don't refactor to a cleanup effect — torrents will die before play starts.
- **YTS domain rotates often.** `YTS_BASE_URL` env is the escape hatch; no auto-failover. Phase 9 adds Knaben as the empty-result fallback.
- **`/stream/:hash/transcoded` shares the router** but belongs to Phase 6.

## Epic Review Findings (2026-08-09)

- 🔗 **Indexer fallback wiring duplicated per adapter, error shapes drift** — spans yts ↔ knaben ↔ torrentday ↔ stremio — extract a `FallbackChain` abstraction in `lib/indexers.ts` so error normalization happens once. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Stream URL absolute-vs-relative contract is implicit** — spans yts ↔ chromecast ↔ stremio ↔ transcoding — add `StartTorrentResult.streamUrlType?: "absolute" | "relative"` in `@castcrate/shared`. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Proxy dispatcher cache and provider LRUs coordinate by convention only** — spans proxy-routing ↔ yts ↔ knaben ↔ torrentday ↔ stremio — export `getCacheKeySuffix()` from `lib/proxy.ts` and have every adapter import it. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Error boundary between adapters and `startTorrent()` is asymmetric** — spans yts ↔ knaben ↔ torrentday ↔ stremio ↔ proxy — add `StartTorrentResult.error?` and 202 on pipeline breaks after route return. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **mkdirSync-at-module-load** — spans scaffold ↔ yts ↔ library-settings ↔ transcoding. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Torrent-lifecycle idempotency** — spans yts ↔ library-settings ↔ transcoding ↔ player-buffer-ux — add double-delete test. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Buffer overlay has no formal state machine** — spans player-buffer-ux ↔ yts ↔ transcoding — extract `useBufferState()` reducer before more state lands. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 💳 **`{ sequentialDownload: true }` not passed explicitly; no concurrency cap** — relies on WebTorrent default; a user can OOM the 8GB box. Pass flag; add `MAX_CONCURRENT_TORRENTS` (default 3). (See epic-overview.md → Tech Debt / Findings.)

_Recorded by /review-epic castcrate on 2026-08-09._
