# yts-streaming — Tasks

**Last updated:** 2026-05-09
**Progress:** Implemented (retrospective)

## Original implementation (completed)

- [x] YTS adapter (`services/yts.ts`) with LRU(200, 1h)
- [x] Quality filter — 1080p / 720p × x264 / h264 only
- [x] WebTorrent singleton (`services/torrent.ts`)
- [x] `pickVideoFile()` — largest by length, mp4/mkv/avi/m4v/webm
- [x] Metadata map keyed by infoHash (title, poster, imdbId, resolution, startedAt)
- [x] `lib/range.ts` — `bytes=start-end`, open-ended, suffix forms
- [x] `GET /stream/:infoHash` — 206 Partial Content, MIME-typed
- [x] `POST /api/torrent/start` — magnet → infoHash, 60s metadata timeout
- [x] `GET /api/torrent/:hash`, `GET /api/torrents` — status, list
- [x] `DELETE /api/torrent/:hash` — remove from client, append history
- [x] Web `TorrentPicker` — top result highlighted, expand-on-click
- [x] Web `Player` — `<video>` + status polling at 1500ms
- [x] StrictMode-safe cleanup (explicit removeTorrent on close)
- [x] Vitest for `yts.ts` and `range.ts`
- [x] Server `onClose` hook destroys WebTorrent client

## Future enhancements

### High priority
- [ ] Pass `{ sequentialDownload: true }` explicitly in `client.add()`
- [ ] Time out pre-buffer reads (503/504) instead of indefinite block
- [ ] Manual file selection UI for multi-file torrents

### Medium priority
- [ ] Stop or slow status polling once `done === true`
- [ ] Concurrent-torrent cap + queue
- [ ] Move status updates to WebSocket push
- [ ] Stalled-stream UI state (no bytes in N sec → warning)

### Low priority
- [ ] Bandwidth limiting (`client.throttleDownload`)
- [ ] Resume on restart from `meta` map persisted to disk
- [ ] Streaming integration test against a public-domain torrent fixture
