# watch-later — Requirements

**Epic:** castcrate
**Created:** 2026-08-12
**Motivation:** CastCrate's core UX today is stream-as-you-download — search, click, cast, watch (with buffering while pieces arrive). It works, but tight-swarm titles + VPN routing (see `vpn-split-tunnel`) make buffering painful. Manual torrent clients solve this by fully downloading first, then playing from disk with zero buffer. This feature brings that pattern to CastCrate with a **Watch Later** queue + a **Library** view.

Real-world flow: user searches a title, clicks "Add to Watch Later" instead of "Cast Now". CastCrate downloads in the background (no player opens). When download completes, the item shows up in Library with its poster + metadata. User later opens Library, clicks Cast, and playback starts instantly from the fully-local file — no buffer, no peer wait, instant seek to any position.

Composes beautifully with `vpn-torrentday-only`: background downloads run at full peer throughput (clearnet); TorrentDay searches happen via VPN; library playback is 100% local disk read (zero network).

## Overview

Add a queue + library system. Search results gain an "Add to Watch Later" action alongside "Cast". Queued items download in the background, decoupled from any active player session. Completed items appear in a new **Library** view with poster / title / year / duration / file size, and Play + Cast + Delete actions. Retention timer (`castcrate-prune.service`) respects a per-item "pinned" flag so library items aren't auto-pruned.

## Requirements

- New server endpoints:
  - `POST /api/library/queue` — body: `{ magnet | torrentBlob, metadata: { title, year, poster, imdbId, ... } }` → adds to queue; if already queued/library, returns 200 with `alreadyPresent: true`.
  - `GET /api/library` — returns `{ queued: QueueItem[], downloading: DownloadingItem[], completed: LibraryItem[] }` (three sections, sorted by add-date desc).
  - `DELETE /api/library/:id` — removes queue entry or completed library item (including the on-disk files).
  - `POST /api/library/:id/pin` — toggles the pinned flag; pinned items are excluded from the retention prune.
  - `POST /api/library/:id/play` — treats the completed download as a torrent (already at 100%) and opens the stream endpoint so existing player + cast pipelines work unchanged. Response: `{ streamUrl: string, hash: string }` — client redirects to the player.
- New server services:
  - `apps/server/src/services/library.ts` — persistent library index (`~/.castcrate/library.json` — JSON, atomic writes, respects `HISTORY_DIR` env). Tracks: `{ id, magnet, hash, title, year, poster, imdbId, addedAt, completedAt | null, pinned, filePath | null }`.
  - `apps/server/src/services/download-queue.ts` — background queue processor. Reads library index, starts WebTorrent downloads for `completedAt: null` items (up to `MAX_CONCURRENT_QUEUED` at a time, default 2). Marks `completedAt` when done and writes `filePath` (relative to `DOWNLOAD_PATH`).
- Extend retention pruning: `castcrate-prune.service` (currently `find ~/castcrate-downloads -type f -mtime +14 -delete`) becomes aware of the library manifest and skips any file listed in the library with `pinned: true`. Implementation: prune script reads `library.json`, builds an exclusion list, uses `find ... -not -path <pinned>` for each pinned path. Alternative if simpler: prune script consults library service via a helper CLI.
- New web routes/views:
  - `apps/web/src/components/Library.tsx` — three-section view (Queue → Downloading → Completed), poster grid layout for Completed, list layout for Queue + Downloading.
  - Search results (in `Search.tsx` or equivalent) gain an "+ Watch Later" button next to the existing "Cast" / "Play" actions.
  - Persistent nav gets a "Library" link (add alongside existing routes).
  - Downloading section shows progress bar per item (from existing torrent status polling).
- Shared types: `LibraryItem`, `QueueItem`, `DownloadingItem`, `LibraryStatus` — additive-only in `packages/shared/src/index.ts`.
- Config: `MAX_CONCURRENT_QUEUED` env (default 2). No other new env vars.
- Deduplication: adding the same magnet/hash twice is a no-op; server returns `alreadyPresent: true`. No duplicate library entries.
- Persistence: `library.json` writes are atomic (write to `.tmp`, rename) so a crash mid-write doesn't corrupt the index. Same pattern as `history.ts` post-hardening.
- The Library view works with `VPN_MODE=off`, `VPN_MODE=vpn`, and `VPN_MODE=torrentday-only`. VPN mode doesn't affect library playback — the file is already on local disk.

## Dependencies

- **External:** None (no new APIs, no new npm dependencies).
- **Repo:** touches `apps/server/src/routes/` (new library route file, or extend existing), `apps/server/src/services/` (new library.ts + download-queue.ts), `packages/shared/src/index.ts` (new types), `apps/web/src/components/` (new Library.tsx, edited Search.tsx + persistent nav), `apps/web/src/lib/api.ts` (new library client functions), and the prune script/unit for the retention change.
- **Existing features to coordinate with**:
  - `library-settings` — closely related name-wise; keep it separate. `library-settings` handles user preferences + history display; `watch-later` handles the queue + downloaded-file library. Consider whether to fold or keep distinct in the plan.
  - `transcoding` — Library playback uses the same `/stream/:hash` endpoint, so transcoding continues to work when needed. No changes.
  - `cast-controls` — Cast from library uses the same cast session flow. No changes.
  - `chromecast` — same as above.
  - `discovery` / `omdb-search` / `tmdb-metadata` (planned) — metadata for library items is captured at add-time from these services. Library stores its own copy of the metadata (title, year, poster URL) so display works even if the metadata service is down.
  - Retention timer (`castcrate-prune.service` in `media-mac-deploy`) — must respect pinned flag. This is a coordination touch, not a rewrite.
- **New docs:** implementation.md, tasks.md, context.md under `docs/features/castcrate/watch-later/`.

## Out of Scope

- Fine-grained bandwidth throttling (e.g., "download at max 2 MB/s so streams don't compete for peers"). Nice-to-have later; not v1.
- Priority queue (reorder queued items). v1 is FIFO.
- Multi-user support / per-user libraries. Single-user by design (matches CastCrate's overall scope).
- Cloud sync of library metadata across instances.
- Video pre-transcoding at completion (transcode on the fly at play-time is fine and already works).
- Notification when a download completes (push, email, etc.). UI polling is enough.
- Storage quota management ("delete oldest unpinned when disk >90% full"). v1 relies on retention timer + manual delete. Auto-quota is a follow-up feature.
- Import of pre-existing files (e.g., a `Movies/` folder from before CastCrate). v1 is queue-forward only.

---

*Consumed by `/plan-feature castcrate/watch-later`. See `implementation.md` for the planning notes drafted alongside these requirements; run `/plan-feature` when ready for the full solution-architect pass.*
