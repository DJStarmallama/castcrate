# Feature: yts-streaming — Phase 2 (Retrospective)

**Status:** Implemented
**Documented:** 2026-05-09
**Phase:** 2

## Executive summary

End-to-end browser playback of a torrent: YTS adapter resolves a magnet, WebTorrent downloads sequentially, and `/stream/:infoHash` serves byte-ranges from the in-progress file straight into a `<video>` element. Status is polled via `/api/torrent/:infoHash` (1.5s interval) — no WebSocket yet at this phase. Scope is **browser-only**; Chromecast lives in Phase 3, transcoding in Phase 6.

The YTS adapter is the canonical "indexer" pattern: thin shim, LRU cache, conforms to the shared `TorrentResult` shape so future indexers (eztv, knaben) drop in next to it.

---

## Architecture

```
TorrentPicker.tsx
       │ GET /api/search/torrents?title&year
       ▼
routes/torrents.ts ──▶ services/yts.ts ──fetch──▶ movies-api.accel.li/api/v2
       │                  │
       │                  └─ LRU(200, 1h) by lower(title)::year
       │
       │ POST /api/torrent/start { magnet, title, posterUrl, imdbId, resolution }
       ▼
services/torrent.ts (singleton WebTorrent)
       │   add → wait metadata → pickVideoFile (largest)
       │   setMeta(infoHash, …)
       ▼
returns { infoHash, videoName, videoLength, streamUrl }

       │ GET /stream/:infoHash (Range)
       ▼
range.ts parses → file.createReadStream({start, end}) → 206 Partial Content
```

## Key files

| Path | Role |
|---|---|
| `apps/server/src/services/yts.ts` | YTS adapter — `searchTorrents()`, `toResult()`, `rank()`, LRU cache, `buildMagnet()` |
| `apps/server/src/services/torrent.ts` | WebTorrent singleton — `getClient()`, `startTorrent()`, `removeTorrent()`, `listActiveTorrents()`, `pickVideoFile()`, in-memory `meta` map |
| `apps/server/src/lib/range.ts` | byte-range parser; handles closed, open-ended, and suffix forms |
| `apps/server/src/lib/quality.ts` | shared codec/resolution parser + `rankTorrent()` (used by EZTV/Knaben — not YTS, which has its own ranker) |
| `apps/server/src/routes/torrents.ts` | `/api/search/torrents`, `/api/torrent/start`, `/api/torrent/:hash`, `/api/torrents`, `/stream/:hash`, `DELETE /api/torrent/:hash`, `/stream/:hash/transcoded` (Phase 6) |
| `apps/web/src/components/TorrentPicker.tsx` | top result auto-highlighted, "show more" lazy expand |
| `apps/web/src/components/Player.tsx` | `<video controls autoPlay>`, status polling at 1500ms, explicit `removeTorrent` on unmount (StrictMode workaround) |
| `apps/web/src/lib/api.ts` | `searchTorrents`, `startTorrent`, `torrentStatus`, `removeTorrent` |
| `packages/shared/src/index.ts` | `TorrentResult`, `TorrentStatus`, `StartTorrentResult` |
| `apps/server/src/services/__tests__/yts.test.ts` | adapter unit tests |
| `apps/server/src/lib/__tests__/range.test.ts` | range parser unit tests |

## YTS adapter

- **Endpoint.** `${YTS_BASE_URL}/list_movies.json?query_term=…&limit=20`. Default `https://movies-api.accel.li/api/v2` (the actual `yts.mx` domain rotates frequently).
- **Quality filter.** Accepts `1080p`/`720p` × `x264`/`h264`. Rejects `2160p`, `x265`, anything else.
- **Ranking.** `rank()` sorts by quality bucket (1080p → 3, 720p → 2) then by seeds desc.
- **Cache.** LRU(200, 1h), key `${title.toLowerCase()}::${year ?? ""}`.
- **Error message.** On `ENOTFOUND`/`EAI_AGAIN`, surface a friendly "YTS domain seized — set `YTS_BASE_URL` or use a VPN" message instead of a stack trace.
- **`castFriendly: true`.** Set post-filter — only x264/h264 results survive, so the flag is always true here. EZTV/Knaben use the flag dynamically.

## WebTorrent integration

- **Singleton.** `clientPromise: Promise<WtClient> | null` lazy-loaded on first call. Dynamic `import("webtorrent")` keeps boot fast.
- **Sequential mode is implicit.** `client.add(magnet, { path }, cb)` does **not** pass `{ sequentialDownload: true }`; relies on WebTorrent defaults. This is a documented inconsistency — design says sequential, code does not assert it. See gotchas.
- **File selection.** `pickVideoFile()` filters by `/\.(mp4|mkv|avi|m4v|webm)$/i`, picks the **largest by length** (handles season packs by accident — biggest episode wins).
- **Metadata map.** `meta: Map<infoHash, { title, posterUrl, imdbId, resolution, startedAt }>` — populated on `/api/torrent/start`, consumed by `/api/torrents` and history.
- **Start fast-path.** If a magnet's infoHash is already in `client.torrents`, reuse it; don't re-add.
- **Lifecycle.** `app.addHook("onClose")` calls `torrent.shutdown()` → `client.destroy()`.
- **Download path.** `config.downloadPath` (default `~/Downloads/LlamaSpitStream`), created at module-load via `mkdirSync recursive`.
- **No concurrency cap.** Single-user assumption; the user can spin up N torrents at once.

## Streaming endpoint (`GET /stream/:infoHash`)

1. Look up file via `getVideoFile(infoHash)` → 404 if torrent or file missing.
2. MIME type: `extToMime(file.name)` — mp4/m4v → `video/mp4`, mkv → `video/x-matroska`, default `application/octet-stream`.
3. Always set `Accept-Ranges: bytes`.
4. If `Range:` header present:
   - Parse via `lib/range.ts` (`bytes=start-end`, `bytes=start-`, `bytes=-suffix`).
   - 206 Partial Content + `Content-Range: bytes start-end/size` + `Content-Length: end-start+1`.
   - `pipe(file.createReadStream({ start, end }))`.
5. No Range: 200 + full stream.

**Pre-buffer behaviour.** WebTorrent's `createReadStream({ start, end })` blocks until the requested bytes are available. There's no timeout; if peers vanish mid-stream, the response stalls until the browser gives up (~30s).

## Status & control endpoints

- `GET /api/torrent/:hash` → `TorrentStatus { infoHash, name, progress, downloadSpeed, numPeers, done, videoLength }`. Polled at 1500ms by `Player.tsx`.
- `GET /api/torrents` → all active, with `meta` joined (title, posterUrl, resolution).
- `POST /api/torrent/start` → adds magnet, awaits metadata (60s timeout), picks video, deselects others.
- `DELETE /api/torrent/:hash` → appends history entry, removes from client. **Files on disk are not deleted by Phase 2** (deletion semantics evolved with Phase 4).

## Tests

- `range.test.ts` — 8 cases (missing/malformed, closed, open-ended, suffix, bounds, inverted).
- `yts.test.ts` — `buildMagnet`, `toResult` (accept/reject quality), `rank`, `rankAndFilter`.

No tests for streaming endpoint, WebTorrent integration, or `Player.tsx` polling (these are integration risks and rely on real peers).

---

## Gotchas

- **Sequential mode is not asserted.** `services/torrent.ts:115` calls `client.add(magnet, { path }, cb)` without `{ sequentialDownload: true }`. WebTorrent currently defaults to sequential when streaming, but this is brittle. Add the flag explicitly.
- **Out-of-range / pre-buffer reads block forever.** Browser timeout is the floor. No retry, no friendly error.
- **`pickVideoFile` returns the largest file.** For season packs this picks one episode — usually the wrong one. Phase 5's TV picker bypasses by adding metadata, but no UI option to choose manually.
- **Polling interval is hardcoded** to 1500ms in `Player.tsx`. No exponential backoff once `done = true`.
- **React StrictMode double-mount.** `Player.tsx` deliberately calls `removeTorrent` from `handleClose` instead of an effect cleanup, because StrictMode's mount→unmount→mount kills the torrent before playback begins.
- **`mkdirSync` at import time.** `lib/config.ts` creates `DOWNLOAD_PATH` synchronously when imported; unwritable parents crash the server at boot.
- **YTS domain rotation.** Code falls back to a friendly error; rotation is handled via `YTS_BASE_URL` env override, not auto-failover. Phase 9 adds Knaben as a search-time fallback.
- **`/stream/:hash/transcoded` lives in the same router.** Belongs to Phase 6, but coexists in `routes/torrents.ts`.

## Future enhancements

### High priority
- [ ] Pass `{ sequentialDownload: true }` explicitly to `client.add`.
- [ ] Time out pre-buffer reads after N seconds with a 503/504, instead of letting the browser hang.

### Medium priority
- [ ] Manual file picker for multi-file torrents (season packs).
- [ ] Stop polling status once `done = true` (or longer interval).
- [ ] Concurrent-torrent limit + queue.

### Low priority
- [ ] Move from polling to WebSocket push (Phase 3 already registers `@fastify/websocket`).
- [ ] Surface "stream stalled" UI state when bytes haven't moved in N seconds.
