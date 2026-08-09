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
