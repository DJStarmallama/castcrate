# watch-later — Implementation Plan

**Epic:** castcrate
**Status:** In Progress
**Started:** 2026-08-12
**Target Completion:** TBD
**Last Updated:** 2026-08-12

---

## Executive Summary

Add a **Watch Later queue** and a **Library** view to CastCrate. Search results gain an "+ Watch Later" action alongside the existing "Cast" action; queued items download in the background with no player attached, and once complete surface in a Library view (poster + metadata + Play/Cast/Delete/Pin). State lives in a single atomic JSON manifest (`~/.castcrate/library.json` — same directory + write pattern as `history.json` post-hardening); the queue processor is an in-process service inside the existing Fastify server that shares the running WebTorrent client, so there is **no new daemon, no new database, no new npm dependency**. Playback from Library reuses the existing `/stream/:hash` pipeline unchanged — because the file is already at 100 %, byte-range reads are instant and cast pipelines "just work." The retention timer (`castcrate-prune.service`) is extended to consult `library.json` and skip any file marked `pinned: true` — the pin flag is the whole product promise (you queued it, you keep it) and is treated as inviolable.

---

## Goals

**Primary**
- User can click "+ Watch Later" on any search result → the title is queued and downloads in the background with no player, no cast session, and no active browser tab required.
- Completed downloads appear in a **Library** view with poster + title + year + file size; Play opens the local file for **zero-buffer, instant-seek** playback (verifiable: `/stream/:hash` returns 200 with a `Content-Length` header immediately and byte-range seeks resolve without peer wait).
- Cast from Library succeeds against the same Chromecast (Master Llama) with the same UX as cast-from-search — no code changes to the cast pipeline.
- Pinned library items are **guaranteed** to survive the retention prune (`castcrate-prune.service`). This is the promise the feature makes; it must be inviolable.
- `library.json` is written atomically (temp + rename), matching the `history.ts` post-hardening pattern — a crash mid-write never corrupts the manifest.
- Adding the same title twice is idempotent (returns `{ alreadyPresent: true }` — no duplicate entries, no re-download).

**Secondary**
- Library view has three sections (Queue → Downloading → Completed) so the user sees the whole pipeline.
- Queue processor resumes correctly across a server restart (queued items still get downloaded; in-progress items resume from the on-disk state WebTorrent already persists).
- Works across all VPN modes (`off`, `vpn`, `torrentday-only` — planned) — library playback is 100 % local disk read and thus VPN-independent.
- Zero regressions on the existing search / cast / stream / retention / history surface — the new services and routes are purely additive.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                 WEB                                       │
│                                                                           │
│   Search.tsx ─────► [+ Watch Later] ────POST /api/library/queue           │
│                            │                                              │
│                     [Cast] (unchanged, existing pipeline)                 │
│                                                                           │
│   TopNav "Library" link ─────► Library.tsx                                │
│                                    ├─ Queue      ─── GET /api/library     │
│                                    ├─ Downloading─── (polls, 2s)          │
│                                    └─ Completed  ─── Play / Cast / Pin /  │
│                                                     Delete                │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                              FASTIFY SERVER                               │
│                                                                           │
│   routes/library.ts                                                       │
│     POST /api/library/queue    ──► services/library.ts::addToQueue()     │
│     GET  /api/library          ──► services/library.ts::listLibrary()    │
│     DELETE /api/library/:id    ──► services/library.ts::remove() + fs    │
│     POST /api/library/:id/pin  ──► services/library.ts::togglePin()      │
│     POST /api/library/:id/play ──► reuses services/torrent.ts start +    │
│                                    returns { streamUrl, hash }           │
│                                                                           │
│                              │                                            │
│                              ▼                                            │
│   services/library.ts (atomic JSON manifest — writes .tmp then rename)   │
│     ~/.castcrate/library.json                                            │
│     [{ id, magnet, hash, title, year, poster, imdbId,                    │
│        addedAt, completedAt|null, pinned, filePath|null, source }, …]    │
│                                                                           │
│                              ▲                                            │
│                              │                                            │
│   services/download-queue.ts (in-process worker; boots on server start)  │
│     - reads manifest at boot; resumes any `completedAt === null` item    │
│     - respects MAX_CONCURRENT_QUEUED (default 2)                         │
│     - hands each queue item to services/torrent.ts::startTorrent()       │
│       (shared WebTorrent client — same one that powers cast-now)          │
│     - watches `torrent.on("done")` → writes completedAt + filePath        │
│     - detaches (files stay on disk); torrent removed from active client   │
│     - kicked on POST /api/library/queue AND on 30s idle poll             │
│                                                                           │
│                              │                                            │
│                              ▼                                            │
│   services/torrent.ts (existing — no changes to public API)              │
│     writes files to DOWNLOAD_PATH via WebTorrent                          │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                                  DISK                                     │
│                                                                           │
│   DOWNLOAD_PATH/<torrent-name>/<video-file>       (WebTorrent-managed)   │
│   ~/.castcrate/library.json                       (manifest)             │
│   ~/.castcrate/library.json.tmp                   (in-flight write)      │
└──────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │
┌──────────────────────────────────────────────────────────────────────────┐
│                       RETENTION (systemd oneshot)                         │
│                                                                           │
│   castcrate-prune.service (nightly + Persistent=true)                    │
│     scripts/prune-downloads.sh                                            │
│       1. Read ~/.castcrate/library.json                                  │
│       2. For each entry where pinned === true and filePath !== null,     │
│          collect the absolute filePath into a pinned-list.               │
│       3. find $DOWNLOAD_PATH -type f -mtime +14 -not -path <p1>          │
│          -not -path <p2> … -print -delete                                 │
│       4. Sweep empty dirs (existing behaviour).                          │
│     Fail-safe: manifest missing or unreadable → skip prune entirely,     │
│                log a warning, exit 0 (never destroy user files on doubt).│
└──────────────────────────────────────────────────────────────────────────┘

Data-flow through library.json:
  queue     : addedAt set, completedAt null, filePath null, hash null (until magnet resolved)
  downloading: addedAt set, completedAt null, filePath null, hash SET, active in WebTorrent
  completed : addedAt set, completedAt SET, filePath SET, hash SET, torrent detached
  pinned    : orthogonal flag — set on any state, respected by prune only
```

**Key invariants**

- **Single writer**: only `services/library.ts` writes `library.json`. The download queue calls into it; routes call into it; the prune script only reads.
- **Atomic writes**: every mutation goes `writeFile('.tmp')` → `rename()`. POSIX rename is atomic — a crash mid-write leaves the previous version intact.
- **In-memory mutex**: an async `Promise` chain (module-level `let writeLock: Promise<void>`) serializes all writes so concurrent `addToQueue` + `markCompleted` calls do not clobber each other's read-modify-write cycle.
- **Idempotent add**: `addToQueue()` first scans the manifest for an existing entry keyed on the torrent's canonical hash (extracted from the magnet URI or read from `torrent.infoHash` post-metadata). Duplicate → returns `{ id, alreadyPresent: true }` and does not spawn a second download.
- **Deletion cascade**: `DELETE /api/library/:id` removes the manifest entry AND the on-disk file (via `client.remove(hash, { destroyStore: true })` if still active, or direct `rm -rf` on the parent directory if already detached). Pinned entries require an explicit un-pin before delete — the API returns 409 Conflict otherwise, to guard against fat-finger destruction of the very files the pin flag was meant to protect.
- **Boot recovery**: on server start, `services/download-queue.ts` reads the manifest and re-spawns any `completedAt === null` item (subject to `MAX_CONCURRENT_QUEUED`). WebTorrent's own on-disk piece store means the download resumes rather than restarting.

---

## Implementation Phases

Effort key: **S** ≤ 2 h, **M** ≤ 1 day, **L** > 1 day.
Phases marked **[max-effort]** should be routed to an advanced dev agent by `/proceed` — they involve concurrency + WebTorrent lifecycle, production scripts that delete files, or real-box verification of the whole pipeline.

### Phase 1 — Shared types + config plumbing

**Goal:** Land the type surface and env plumbing that every other phase depends on. Additive only — no touched code paths change behaviour.

**Effort:** S

**Tasks**
- [ ] Add to `packages/shared/src/index.ts` (additive, alphabetized where appropriate):
  ```ts
  export type LibraryStatus = "queued" | "downloading" | "completed";

  /** One row of ~/.castcrate/library.json.
   *  `hash` is null while a magnet is still being resolved (fetch-metadata phase);
   *  `filePath` is null until the download completes; `completedAt` is null
   *  until the same moment. `pinned` is orthogonal to state and controls
   *  retention-prune eligibility only. */
  export interface LibraryItem {
    /** Client-stable id. Generated server-side on add — `crypto.randomUUID()`.
     *  Independent of `hash` so we can reference an item even before metadata
     *  resolves. */
    id: string;
    /** Magnet URI. Present for magnet-added items; absent when the item came
     *  from a .torrent blob (rare — TorrentDay). */
    magnet: string | null;
    /** WebTorrent infoHash (lowercase). Null until metadata resolves. Once
     *  set, becomes the dedupe key. */
    hash: string | null;
    /** Snapshot of metadata at add-time, so display works even if OMDB/TMDB
     *  is down when the user opens Library. */
    title: string;
    year: number | null;
    poster: string | null;
    imdbId: string | null;
    /** Which torrent source produced this — mirrors TorrentResult.source. */
    source: "yts" | "eztv" | "knaben" | "torrentday" | "stremio" | "unknown";
    /** ISO 8601 add time. */
    addedAt: string;
    /** ISO 8601 completion time; null while queued/downloading. */
    completedAt: string | null;
    /** Absolute path (relative to DOWNLOAD_PATH) to the picked video file.
     *  Null until completion. Written by the download-queue worker. */
    filePath: string | null;
    /** Retention-prune exclusion flag. Inviolable — a pinned entry's file
     *  MUST NOT be deleted by castcrate-prune.service. */
    pinned: boolean;
  }

  /** Wire shape returned by `GET /api/library`. Sections are pre-sorted
   *  add-date desc so the client renders straight from the payload. */
  export interface LibraryListResponse {
    queued: LibraryItem[];       // completedAt === null && hash === null
    downloading: LibraryItem[];  // completedAt === null && hash !== null
    completed: LibraryItem[];    // completedAt !== null
  }

  /** POST /api/library/queue request. Metadata is captured at add-time
   *  from whichever search source produced the row — the queue never
   *  re-fetches. */
  export interface AddToQueueRequest {
    magnet: string;
    metadata: {
      title: string;
      year: number | null;
      poster: string | null;
      imdbId: string | null;
      source: LibraryItem["source"];
    };
  }

  export interface AddToQueueResponse {
    id: string;
    alreadyPresent: boolean;
  }

  /** POST /api/library/:id/play response — the client uses `streamUrl`
   *  to redirect straight to the player. `hash` is exposed for cast + status
   *  polling consistency with the existing torrent surface. */
  export interface LibraryPlayResponse {
    streamUrl: string;
    hash: string;
  }
  ```
- [ ] Add to `apps/server/src/lib/config.ts`:
  ```ts
  /** Max concurrent background downloads spawned by the Watch Later queue.
   *  Kept low by default because the 2011 MBP box has 8 GB RAM and shares
   *  WebTorrent capacity with the cast-now stream. Increase if the box gains
   *  headroom. See watch-later feature — Key Decisions #3. */
  maxConcurrentQueued: Number(process.env.MAX_CONCURRENT_QUEUED ?? 2),
  ```
- [ ] Add `MAX_CONCURRENT_QUEUED=2` to `.env.example` with a short doc line.
- [ ] `pnpm -r typecheck` passes; existing tests still green.

**Files touched**
- `packages/shared/src/index.ts` (additive types)
- `apps/server/src/lib/config.ts` (one field)
- `.env.example` (one line + comment)

**Acceptance criteria**
- `import type { LibraryItem, LibraryStatus, LibraryListResponse, AddToQueueRequest, AddToQueueResponse, LibraryPlayResponse } from "@castcrate/shared"` resolves in both apps.
- `config.maxConcurrentQueued === 2` when the env var is unset.
- No behavioural change anywhere; only compile-time surface added.

---

### Phase 2 — `services/library.ts` — atomic manifest CRUD

**Goal:** Own the `library.json` file with the same care as `history.ts`. Every mutation is atomic; concurrent callers serialize; corrupt or missing manifest degrades gracefully.

**Effort:** M

**Tasks**
- [ ] Create `apps/server/src/services/library.ts`. Mirror `history.ts`'s structure verbatim:
  - `LIBRARY_DIR = process.env.HISTORY_DIR ? resolve(...) : join(homedir(), ".castcrate")` (deliberately reuse `HISTORY_DIR`, not a new env var — one directory holds all CastCrate JSON state; the hardening precedent set the pattern).
  - `LIBRARY_PATH = join(LIBRARY_DIR, "library.json")`, `TMP_PATH = ${LIBRARY_PATH}.tmp`.
  - `let cache: LibraryItem[] | null = null;`
  - `async function ensureDir()` — identical to history.ts.
  - `async function load()` — cached read; on parse error, log a warning (visible in journalctl — history.ts's silent fallback is called out as a gotcha in `library-settings/context.md`, so we do better here) and fall back to `[]`.
  - `async function save()` — write to `.tmp`, then `rename()` to path. **Serialized via a module-level `writeLock: Promise<void>`** — every `save()` awaits the previous one before its own write starts. This is the mutex that prevents concurrent `addToQueue` + `markCompleted` from racing the read-modify-write cycle.
- [ ] Public API:
  ```ts
  export async function listLibrary(): Promise<LibraryListResponse>;
  export async function findByHash(hash: string): Promise<LibraryItem | null>;
  export async function findByMagnet(magnet: string): Promise<LibraryItem | null>;
  export async function findById(id: string): Promise<LibraryItem | null>;
  export async function addToQueue(req: AddToQueueRequest): Promise<AddToQueueResponse>;
  export async function setHash(id: string, hash: string): Promise<void>;
  export async function markCompleted(id: string, filePath: string): Promise<void>;
  export async function togglePin(id: string): Promise<LibraryItem>;
  export async function removeItem(id: string, opts: { force?: boolean }): Promise<{ removedFile: string | null }>;
  export async function listPinnedFilePaths(): Promise<string[]>;  // used by prune script's server-helper CLI variant if chosen
  ```
- [ ] `addToQueue` semantics:
  - Extract hash from magnet (`xt=urn:btih:<HEX>`); lowercase it. If extraction fails (e.g. non-standard magnet), leave hash null — the queue processor will fill it in after metadata fetch.
  - Look for an existing entry with matching `hash` (if we could extract) OR matching `magnet` string. If found → return `{ id: existing.id, alreadyPresent: true }` without appending.
  - Otherwise generate `id = crypto.randomUUID()`, push a new entry with `addedAt = new Date().toISOString()`, `completedAt: null`, `filePath: null`, `pinned: false`, and metadata snapshot from the request.
  - Save.
- [ ] `setHash` — called by the download-queue worker once `torrent.infoHash` is known post-metadata. Updates the existing entry (by id) and re-serializes.
- [ ] `markCompleted(id, filePath)` — sets `completedAt = new Date().toISOString()` and `filePath = <relative-or-absolute-path>`. Path convention: **absolute** — simpler for the prune script and the play route (no `resolve()` gymnastics).
- [ ] `togglePin` — flip the `pinned` flag; return the updated entry. UI can re-render optimistically from the response.
- [ ] `removeItem` — refuses to remove pinned entries unless `opts.force === true` (guardrail against the exact promise this feature makes). Returns the `filePath` (if any) so the route can delete on disk after the manifest is updated.
- [ ] `listPinnedFilePaths` — returns absolute paths of every pinned entry with `filePath !== null`. Used by the prune-script helper in Phase 5.
- [ ] Section-splitting for `listLibrary`: sort the whole cache by `addedAt` desc, then filter into three buckets by state. Return `{ queued, downloading, completed }`.

**Files touched (new)**
- `apps/server/src/services/library.ts`

**Acceptance criteria**
- Add a queue entry → `library.json` on disk contains one new object with `addedAt`, `completedAt: null`, `pinned: false`.
- Add the same magnet twice → second call returns `alreadyPresent: true`; manifest still has one entry.
- Kill the process with `kill -9` mid-write → manifest either has the pre-write state or the post-write state, never a truncated file.
- Concurrent `addToQueue` + `markCompleted` on different entries → both succeed; manifest ends up with both mutations applied (no lost write).
- Corrupt `library.json` on disk (manual truncate) → server logs a warning at load, cache falls back to `[]`, subsequent adds succeed.

---

### Phase 3 — `services/download-queue.ts` — background worker **[max-effort]**

**Goal:** Take queued items and drive them to completion in the background, sharing the existing WebTorrent client. Survive server restarts, respect `MAX_CONCURRENT_QUEUED`, mark items complete atomically.

**Effort:** M

Why max-effort: WebTorrent lifecycle (metadata timeout, done event, error paths, close listeners), concurrency bookkeeping, and the interaction with the existing torrent service (which the cast pipeline also uses). Any bug here either fails to download a queued item silently, or leaks torrents into the client and OOMs the box.

**Tasks**
- [ ] Create `apps/server/src/services/download-queue.ts`.
- [ ] Module-level state:
  ```ts
  const active = new Map<string /* libraryId */, { infoHash: string; startedAt: number }>();
  let scanTimer: NodeJS.Timeout | null = null;
  let scanRunning = false;
  ```
- [ ] Public API:
  ```ts
  export function startDownloadQueue(): void;   // kick off the poll + first scan; called from bootstrap
  export function stopDownloadQueue(): Promise<void>;  // graceful — called from onClose
  export function kick(): void;                 // called by POST /api/library/queue to run scan immediately
  ```
- [ ] `startDownloadQueue()`:
  1. On boot, run one scan pass.
  2. Schedule `setInterval(scan, 30_000)`. 30s is a safety net — the primary trigger is `kick()` from the queue-add route.
- [ ] `scan()` (guarded by `scanRunning` boolean to prevent overlapping passes):
  1. `const items = await load(); const queued = items.filter(i => i.completedAt === null && !active.has(i.id));`
  2. While `active.size < config.maxConcurrentQueued && queued.length > 0`, pop the oldest queued item (FIFO by `addedAt`) and spawn it.
- [ ] `spawn(item: LibraryItem)`:
  1. `active.set(item.id, { infoHash: item.hash ?? "", startedAt: Date.now() });`
  2. Call `startTorrent(item.magnet)` from `services/torrent.ts` (shared client — the exact same code path cast-now uses).
  3. Once metadata resolves, `startTorrent()` returns a `TorrentSession` with `infoHash` — call `library.setHash(item.id, session.infoHash)` immediately so the manifest reflects the resolved hash (and the UI's "Downloading" section can join with `/api/torrents` progress).
  4. Get the underlying `WtTorrent` via `getTorrent(hash)`; attach `torrent.once("done", async () => await onComplete(item, session))`.
  5. Attach `torrent.once("error", async (err) => await onError(item, err))` and `torrent.once("close", async () => { active.delete(item.id); scheduleScan(); })` — close covers external teardown.
- [ ] `onComplete(item, session)`:
  1. Compute the absolute file path: `join(config.downloadPath, session.name, session.videoName)` (or reuse the existing helper if present — verify against `torrent.ts` behaviour: the torrent's on-disk layout is `<downloadPath>/<torrent.name>/…`).
  2. Verify the file exists (`fs.stat`) — belt + braces.
  3. `await library.markCompleted(item.id, absolutePath);`
  4. **Detach the torrent from the WebTorrent client** — call `removeTorrent(session.infoHash, { destroyStore: false })`. The files stay on disk (that's the whole point); the client releases its bookkeeping. This is critical: leaving the torrent attached keeps it seeding, uses RAM, and eventually OOMs the box across many queued items.
  5. `active.delete(item.id); kick();` — free the slot; try to start the next queued item immediately.
- [ ] `onError(item, err)`:
  1. Log with `[download-queue] item=${item.id} title=${item.title}` prefix.
  2. Leave the manifest entry as-is (`completedAt: null`) — a subsequent scan pass will retry. **YAGNI:** no exponential backoff in v1; the 30s scan interval is the retry cadence.
  3. `active.delete(item.id); scheduleScan();` — free the slot.
- [ ] `stopDownloadQueue()`:
  1. `clearInterval(scanTimer)`.
  2. Do not tear down active torrents — leave them to the WebTorrent client's own shutdown hook (`services/torrent.ts::shutdown()`). Any in-flight `markCompleted` await chains resolve naturally; the manifest ends up in a consistent state.
- [ ] Wire `startDownloadQueue()` at the end of the server bootstrap (after routes registered, before `app.ready()` resolves). Register `app.addHook("onClose", async () => { await stopDownloadQueue(); })`.

**Files touched (new)**
- `apps/server/src/services/download-queue.ts`

**Files touched (edit)**
- `apps/server/src/index.ts` — one `startDownloadQueue()` call + `onClose` hook.

**Acceptance criteria**
- Queue 3 items with `MAX_CONCURRENT_QUEUED=2` → only 2 spawn WebTorrent adds simultaneously; the 3rd starts when either of the first two completes or errors.
- Kill the server mid-download → restart → the same item resumes downloading (WebTorrent's piece store on disk means partial progress is preserved).
- Complete a download → `library.json` shows `completedAt` set and `filePath` populated; the WebTorrent client no longer has the torrent (`GET /api/torrents` returns without it).
- Two concurrent `addToQueue` calls for different items → both enter the manifest; the worker picks them up without racing (verify manifest ends up with both entries — no lost write).
- A malformed magnet added to the queue → the item errors; server logs the error; a re-scan 30s later retries; other items in the queue are unaffected.

---

### Phase 4 — Routes: `POST/GET/DELETE/POST` under `/api/library`

**Goal:** Wire the HTTP surface. Every route is a thin adapter over `services/library.ts` + `services/torrent.ts`.

**Effort:** S–M

**Tasks**
- [ ] Create `apps/server/src/routes/library.ts`:
  ```ts
  export async function libraryRoutes(app: FastifyInstance) {
    app.post<{ Body: AddToQueueRequest }>(
      "/api/library/queue",
      async (req, reply) => {
        // Body validation: magnet is a non-empty string starting with "magnet:";
        // metadata is present with at least `title` and `source`.
        const { magnet, metadata } = req.body;
        if (!magnet?.startsWith("magnet:")) return reply.code(400).send({ error: "invalid magnet" });
        if (!metadata?.title || !metadata?.source) return reply.code(400).send({ error: "invalid metadata" });
        const result = await addToQueue({ magnet, metadata });
        kick();  // wake the queue processor immediately
        return result;
      },
    );

    app.get("/api/library", async () => listLibrary());

    app.delete<{ Params: { id: string } }>(
      "/api/library/:id",
      async (req, reply) => {
        const item = await findById(req.params.id);
        if (!item) return reply.code(404).send({ error: "not found" });
        if (item.pinned) return reply.code(409).send({ error: "pinned — unpin before delete" });
        // If active in WebTorrent, remove via client + destroyStore; else rm the file directly.
        if (item.hash) {
          try { await removeTorrent(item.hash, { destroyStore: true }); } catch { /* already gone */ }
        }
        if (item.filePath) {
          try { await unlink(item.filePath); } catch { /* already gone */ }
          // Best-effort: rmdir the enclosing torrent directory if empty (mirrors prune script's empty-dir sweep).
          try { await rmdir(dirname(item.filePath)); } catch { /* not empty or not dir — fine */ }
        }
        await removeItem(item.id, { force: false });  // manifest update
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { id: string } }>(
      "/api/library/:id/pin",
      async (req, reply) => {
        const updated = await togglePin(req.params.id);
        if (!updated) return reply.code(404).send({ error: "not found" });
        return updated;
      },
    );

    app.post<{ Params: { id: string } }>(
      "/api/library/:id/play",
      async (req, reply) => {
        const item = await findById(req.params.id);
        if (!item || !item.hash || !item.filePath || !item.completedAt) {
          return reply.code(409).send({ error: "not ready to play" });
        }
        // Re-add the torrent to the WebTorrent client from the on-disk store.
        // WebTorrent's client.add(magnet, { path: DOWNLOAD_PATH }) with the
        // pieces already on disk resumes as "done" instantly; the same
        // /stream/:hash endpoint serves byte ranges from those local pieces.
        // The magnet is what we stored at queue-time.
        if (!item.magnet) return reply.code(500).send({ error: "no magnet to re-add" });
        await startTorrent(item.magnet);
        return { streamUrl: `/stream/${item.hash}`, hash: item.hash } satisfies LibraryPlayResponse;
      },
    );
  }
  ```
- [ ] Register `libraryRoutes(app)` in the server bootstrap alongside the existing route registrations.
- [ ] Body validation notes:
  - Fastify's JSON schema plugin is already in use for some routes — either follow that pattern here or keep it hand-rolled (as above). Match whichever is dominant in the codebase.
  - Do not trust the metadata blob's URL shape (`poster`) — pass through as-is; the UI is responsible for rendering.
- [ ] Deduplicate `DELETE` semantics: idempotent — deleting an already-gone id returns 404, not an error state. Deleting a still-downloading item cancels the download (`removeTorrent(hash, { destroyStore: true })` handles both the client detach and the on-disk cleanup).

**Files touched (new)**
- `apps/server/src/routes/library.ts`

**Files touched (edit)**
- `apps/server/src/index.ts` — one `await app.register(libraryRoutes);` line.

**Acceptance criteria**
- `POST /api/library/queue` with a valid magnet + metadata → 200 with `{ id, alreadyPresent: false }`; subsequent identical call → 200 with `{ id: <same>, alreadyPresent: true }`.
- `GET /api/library` → three sections; each item has the shared type shape.
- `POST /api/library/:id/pin` → toggles the flag; response is the updated `LibraryItem`.
- `DELETE /api/library/:id` on a pinned item → 409 Conflict; on an unpinned completed item → 204 and the file is gone from disk.
- `POST /api/library/:id/play` on a completed item → 200 with `{ streamUrl: "/stream/<hash>", hash }`; client GET on that URL returns 200 with a valid `Content-Length` immediately (proves the file is fully local).

---

### Phase 5 — Retention prune extension — pinned-file exclusion **[max-effort]**

**Goal:** Extend the existing `castcrate-prune.service` (in `media-mac-deploy` Phase 7) so it consults `library.json` and does not delete files listed with `pinned: true`. This is the whole product promise — the pin flag must be inviolable.

**Effort:** M

Why max-effort: the prune script deletes files. A wrong exclusion list wipes user data (the exact opposite of the promise). Fail-safe behaviour (skip prune on any doubt) is non-negotiable.

**Design choice (Option A of three considered — see Key Decisions #5):** the prune script reads `library.json` directly and constructs a `find … -not -path <p>` invocation. No extra process, no dependency on Fastify being up, transparent to inspect.

**Tasks**
- [ ] Write `scripts/prune-downloads.sh`. Purpose: replace the inline `find` command that currently lives in `castcrate-prune.service` (see `media-mac-deploy/tasks.md` Phase 7):
  ```bash
  #!/usr/bin/env bash
  # scripts/prune-downloads.sh
  # Nightly retention prune for CastCrate downloads directory.
  # Skips any file listed in ~/.castcrate/library.json with pinned: true.
  # FAIL-SAFE: if the manifest is missing or unreadable, skip prune entirely
  # (exit 0). Never delete files when we cannot verify the pin list.
  set -euo pipefail

  DOWNLOAD_PATH="${DOWNLOAD_PATH:-/home/castcrate/castcrate-downloads}"
  LIBRARY_JSON="${HISTORY_DIR:-/home/castcrate/.castcrate}/library.json"
  RETENTION_DAYS="${RETENTION_DAYS:-14}"

  echo "[prune] download-path=$DOWNLOAD_PATH library-json=$LIBRARY_JSON retention=${RETENTION_DAYS}d"

  # Build the pinned-path exclusion list. jq is a hard dependency — declare it
  # explicitly in the apt install list (add jq to media-mac-deploy Phase 3).
  # If the manifest is missing, treat the list as empty AND still prune —
  # that's the "no library exists yet" clean-install case, which is safe.
  # If the manifest exists but is unreadable/corrupt, fail-safe: skip prune.
  pinned_args=()
  if [ -f "$LIBRARY_JSON" ]; then
    if ! pinned_paths=$(jq -r '.[] | select(.pinned == true and .filePath != null) | .filePath' "$LIBRARY_JSON" 2>/dev/null); then
      echo "[prune] library.json unreadable — skipping prune (fail-safe)"
      exit 0
    fi
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      pinned_args+=(-not -path "$p")
    done <<< "$pinned_paths"
    echo "[prune] pinned files excluded: ${#pinned_args[@]} paths"
  else
    echo "[prune] no library.json — pruning without exclusions (clean-install case)"
  fi

  # Delete files older than the retention window, honouring the exclusion list.
  # -print for the journal record so we can see what got pruned.
  find "$DOWNLOAD_PATH" -type f -mtime "+$RETENTION_DAYS" "${pinned_args[@]}" -print -delete

  # Sweep now-empty directories (existing behaviour).
  find "$DOWNLOAD_PATH" -type d -empty -delete
  ```
- [ ] Update `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 7 to describe the new script:
  - Add `jq` to the Phase 3 apt install list (single-line diff).
  - `castcrate-prune.service`'s `ExecStart=` becomes `/opt/castcrate/scripts/prune-downloads.sh` instead of the inline `find` command.
  - `EnvironmentFile=/home/castcrate/castcrate/apps/server/.env` (or an explicit set of `Environment=` lines for `DOWNLOAD_PATH`, `HISTORY_DIR`, `RETENTION_DAYS`) so the script picks up the same paths as the running server.
  - Keep the sandbox hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=$DOWNLOAD_PATH`) — but note that `ProtectHome=read-only` still lets us **read** `~/.castcrate/library.json` (which is what we need).
- [ ] Add `shellcheck scripts/prune-downloads.sh` to the CI job if `shellcheck` is already in the pipeline; otherwise document as a manual run.
- [ ] Fail-safe test cases (documented in Phase 8 too):
  - Manifest present, no pinned entries → prune deletes old files as before.
  - Manifest present, one pinned file older than 14 days → that file survives; other old files are deleted.
  - Manifest missing → prune runs normally (clean-install case).
  - Manifest corrupt (jq fails) → prune exits 0 without deleting anything; journal shows the "unreadable — skipping" line.
- [ ] Consider a helper CLI in the server package (`node dist/cli/pinned-paths.js`) as an alternative to the jq dependency — **rejected** (see Key Decisions #5): would require the server to be built and available on the box, adds a process spawn per prune run, and jq is a 200KB apt install that most Ubuntu deploys already have.

**Files touched (new)**
- `scripts/prune-downloads.sh`

**Files touched (edit)**
- `docs/features/castcrate/media-mac-deploy/tasks.md` — Phase 3 apt list gets `jq`; Phase 7 references the new script.
- The deployed `/etc/systemd/system/castcrate-prune.service` (not in repo — updated during Phase 8 deployment).

**Acceptance criteria**
- Script passes `shellcheck` with no warnings.
- With a manifest containing one `pinned: true` file older than 14 days: `bash scripts/prune-downloads.sh` deletes other old files but not the pinned one.
- With a missing `library.json`: script runs cleanly, prunes based on mtime only.
- With a corrupt `library.json`: script logs the fail-safe line and exits 0 without deleting anything (verify by `touch -d "20 days ago" /tmp/testfile && truncate -s 5 ~/.castcrate/library.json && bash scripts/prune-downloads.sh` — the test file survives).
- Idempotent: run the script twice; second run has nothing to do.

---

### Phase 6 — UI: Library view + "+ Watch Later" action + nav link

**Goal:** Wire the user-facing surface. Three sections in Library, a new button in Search, and a persistent nav link.

**Effort:** M

**Naming note — library-settings collision.** The existing `apps/web/src/components/Library.tsx` is the modal that shows *active downloads + history* (per `library-settings` retrospective). It is a **modal**, not a route. This feature adds a new persistent view — pick a different name to avoid confusion: **`WatchLaterLibrary.tsx`** (or `LibraryView.tsx` — decide during implementation, but do not overwrite the existing `Library.tsx`). Leave the modal in place; it serves a different purpose (real-time active + historical audit) and can coexist. The nav pill label is "Library" but the route is `/library` and the component is `WatchLaterLibrary`.

**Tasks**
- [ ] Add API client helpers in `apps/web/src/lib/api.ts`:
  ```ts
  addToQueue(req: AddToQueueRequest): Promise<AddToQueueResponse>;
  library(): Promise<LibraryListResponse>;
  playLibraryItem(id: string): Promise<LibraryPlayResponse>;
  pinLibraryItem(id: string): Promise<LibraryItem>;
  deleteLibraryItem(id: string): Promise<void>;
  ```
- [ ] Create `apps/web/src/components/WatchLaterLibrary.tsx`:
  - Uses `useQuery({ queryKey: ["library"], queryFn: api.library, refetchInterval: 2000 })` — 2s poll matches existing torrent-status polling cadence so the Downloading section reflects real progress.
  - Three sections rendered in order (Queue → Downloading → Completed); each with a title + count.
  - **Completed:** poster-grid layout (same responsive breakpoints as `ResultsGrid`); each tile shows poster + title + year + file size + Play / Cast / Pin toggle / Delete buttons.
  - **Downloading:** list layout; each row shows poster (small) + title + progress bar + speed + peers. Joins `library.json` items (by `hash`) with `/api/torrents` results for live progress. Fall back to "waiting for metadata…" when `hash === null`.
  - **Queue:** list layout; each row shows poster + title + "waiting for slot" or "queued" label + Delete button (remove from queue).
  - Pin button uses a pin icon; state reflects `pinned: boolean`. Optimistic UI on toggle (matches the `cast-controls` optimistic-seek pattern from hardening Phase C).
  - Delete on pinned item is disabled with a tooltip: "Unpin first — pinned items are protected from retention."
  - Play button: on click, `await api.playLibraryItem(id)` → navigate to `/player?hash=<hash>` (same route the existing Cast flow uses; verify against actual player route during implementation).
  - Cast button: on click, opens the existing Cast device picker → uses the existing `/api/cast/play` handler with the `streamUrl` from the library response. **Zero changes to the cast pipeline.**
- [ ] Add a "+ Watch Later" button in the search-result / torrent-picker view. Locate the current `TorrentPicker` component (referenced in `omdb-search/implementation.md` and `hardening` A5). Add the button alongside the existing Cast button, same styling. On click:
  ```ts
  await api.addToQueue({
    magnet: result.magnet,
    metadata: {
      title: movieMetadata.title,
      year: movieMetadata.year,
      poster: movieMetadata.poster,
      imdbId: movieMetadata.imdbId,
      source: result.source,
    },
  });
  ```
  Show a toast: "Added to Watch Later" (or "Already queued" if `alreadyPresent === true`).
- [ ] Add "Library" link to the persistent nav (locate the nav component during implementation — `App.tsx` currently mounts nav elements per `vpn-split-tunnel` Phase 5). Matches the styling of the existing VpnStatusPill approach. Route: `/library`.
- [ ] React Router integration: register `/library` → `<WatchLaterLibrary />` in whatever router config the app uses. If the app is not currently using React Router, defer to the pattern the codebase adopts (a state-based route selector in `App.tsx` is fine).

**Files touched (new)**
- `apps/web/src/components/WatchLaterLibrary.tsx`

**Files touched (edit)**
- `apps/web/src/lib/api.ts` — five new client functions.
- `apps/web/src/components/TorrentPicker.tsx` (or the current search-result-actions component) — add the "+ Watch Later" button.
- `apps/web/src/App.tsx` (or the routing surface) — new route + nav link.

**Acceptance criteria**
- From a search result, "+ Watch Later" adds the item; toast confirms.
- Library route renders three sections; empty sections show a placeholder ("Nothing queued yet"); populated sections render correctly.
- Downloading section polls every 2s and shows live progress that matches `/api/torrents` for the same hash.
- Play button on a completed item loads `/stream/<hash>` and the player starts within ~500ms (no peer wait — the file is local).
- Pin toggle flips the icon; a subsequent DELETE on the same item returns 409 with a UI toast; unpinning re-enables Delete.
- Nav "Library" link is visible on every route and highlights when active.

---

### Phase 7 — Unit tests

**Goal:** Vitest coverage for the two new services. Mock `fs` for manifest state; mock the WebTorrent surface for the queue worker.

**Effort:** S–M

**Tasks**
- [ ] `apps/server/src/services/__tests__/library.test.ts`:
  - `addToQueue` → cache and manifest both updated; second identical add returns `alreadyPresent: true`.
  - Concurrent adds (two different magnets, `Promise.all([a, b])`) → both entries land in the manifest (writeLock works).
  - `markCompleted` → sets `completedAt` and `filePath`; the same item appears in the `completed` section afterwards.
  - `togglePin` → flips the flag; returns the updated entry.
  - `removeItem(id, { force: false })` on a pinned entry → throws / returns null (per chosen API); the entry stays in the manifest.
  - Corrupt manifest at load → cache falls back to `[]`; add succeeds.
- [ ] `apps/server/src/services/__tests__/download-queue.test.ts`:
  - Mock the WebTorrent client (return a fake torrent with an `on("done", cb)` we can invoke).
  - Boot with 3 queued items and `MAX_CONCURRENT_QUEUED=2` → only 2 spawn; after one "done" fires, the 3rd spawns.
  - "done" fires → `markCompleted` called with the expected `filePath`; the torrent is detached from the client.
  - Error event fires → the item stays queued (no `completedAt` write); the next scan retries.
- [ ] Match the existing test conventions (Vitest, `describe`/`it`, `beforeEach` cleanup). Model on `apps/server/src/services/__tests__/history.test.ts` and `torrent.test.ts` (hardening artefact).

**Files touched (new)**
- `apps/server/src/services/__tests__/library.test.ts`
- `apps/server/src/services/__tests__/download-queue.test.ts`

**Acceptance criteria**
- `pnpm test` includes the new suites; both pass.
- Total test count increases by at least 10 (5 in each file).

---

### Phase 8 — Real-box deployment + end-to-end verification **[max-effort]**

**Goal:** Prove the feature works on the deployed 2011 MBP box under realistic conditions. Deploy the new script, add 10 queued titles, verify all complete, pin 2, run the prune script manually, confirm pinned survive.

**Effort:** M

Why max-effort: real-box execution, retention-prune touches production deletion, and the DoD promise (pinned files inviolable) can only be verified live.

**Tasks**
- [ ] Deploy the code (`git pull && pnpm build && sudo systemctl restart castcrate` — standard).
- [ ] Deploy the new prune script: `scp scripts/prune-downloads.sh castcrate@<box>:/tmp/ && sudo mv /tmp/prune-downloads.sh /opt/castcrate/scripts/ && sudo chmod +x /opt/castcrate/scripts/prune-downloads.sh`.
- [ ] Install `jq` on the box: `sudo apt install -y jq`.
- [ ] Update `/etc/systemd/system/castcrate-prune.service`'s `ExecStart=` to the new script; add `EnvironmentFile=/home/castcrate/castcrate/apps/server/.env`.
- [ ] `sudo systemctl daemon-reload; sudo systemctl start castcrate-prune.service` (dry-run on a clean library — should be a no-op that exits 0).
- [ ] From a LAN laptop browser: open `http://castcrate.local:3000`.
- [ ] Search 10 titles across mixed sources (2 YTS, 2 Knaben, 2 TorrentDay, 2 Stremio, 2 EZTV — episodes). Click "+ Watch Later" on each.
- [ ] Open Library. Verify the 10 items appear in Queue (first 8) + Downloading (first 2, honouring `MAX_CONCURRENT_QUEUED=2`).
- [ ] Wait for downloads to complete (walk away — the whole point is that no browser tab is needed). Come back N hours later. Verify all 10 appear in Completed with poster + metadata rendered.
- [ ] Pin 2 items (pick 2 that are >0 bytes and will remain on disk).
- [ ] Manually set the mtime of the 2 pinned files + 2 unpinned files to 20 days ago: `sudo touch -d "20 days ago" <path>`.
- [ ] Manually run the prune: `sudo systemctl start castcrate-prune.service`. Check `journalctl -u castcrate-prune -n 50`.
- [ ] Verify the 2 pinned files still exist; the 2 unpinned old files are gone.
- [ ] Verify Library still renders correctly — the manifest entries for the 2 deleted files should ideally be pruned/marked-stale by a startup validator (see Risks R4). In v1, they'll show as "file missing" — acceptable but noted.
- [ ] Cast one of the completed items to Master Llama. Confirm playback starts within ~5s (no peer wait; file is local).
- [ ] Regression: search + cast a new title *without* queuing (the existing cast-now flow). Confirm zero regression.
- [ ] Reboot the box. Verify Library still renders; any items that were mid-download at shutdown resume on their own after ~30s.

**Files touched**
- On the box: `/opt/castcrate/scripts/prune-downloads.sh`, `/etc/systemd/system/castcrate-prune.service`. All outside the repo.

**Acceptance criteria**
- All 10 queued titles reach Completed without any browser tab open.
- Cast from Library succeeds (Master Llama).
- Prune script deletes only unpinned old files; pinned survive.
- Reboot survival: Library persists; in-flight downloads resume.
- Cast-now (existing flow) still works.

---

## Key Technical Decisions

### 1. JSON manifest (`library.json`) vs SQLite

**Decision:** JSON manifest with atomic writes.

**Alternatives considered:**
- **SQLite via `better-sqlite3`.** Adds a native dep + a new backup story + a schema-migration surface.
- **A single new JSON file (chosen).** Mirrors the existing `~/.castcrate/history.json` pattern the codebase already uses.

**Rationale:** v1 stores tens of entries, not thousands. Reading + writing the whole file on every mutation is O(n) but n is tiny. The codebase's persistence pattern is JSON + atomic-write (hardening B1); introducing SQLite would fragment the state story and add a database file the retention-prune script and the operator would have to reason about separately. YAGNI. Revisit if the library ever hits ~10k entries (never, in a single-user home-media context) or if we need transactional guarantees across multiple files.

### 2. Single-process queue worker (in-Fastify) vs separate daemon

**Decision:** In-process worker inside the running Fastify server. Boots with the server; shuts down with it.

**Alternatives considered:**
- **Separate `castcrate-download-queue.service` systemd unit.** Two processes to reason about; two WebTorrent clients contending for peers; two file-lock owners of `library.json`; two OOM footprints on an 8 GB box.
- **In-process worker (chosen).**

**Rationale:** The queue processor is stateless-across-restarts (state lives in `library.json`) and reuses the existing WebTorrent client that already runs inside Fastify for the cast-now flow. Sharing the client avoids double-adding torrents, halves the peer-connection footprint, and eliminates any coordination protocol between two WebTorrent instances. Cost: server crashes take the queue with them, but a restart resumes automatically (Phase 3 boot recovery) and the queue is intrinsically resumable via WebTorrent's on-disk piece store.

### 3. `MAX_CONCURRENT_QUEUED = 2` default

**Decision:** Default 2, env-tunable.

**Rationale:** The 2011 MBP box has 8 GB RAM. Empirical CastCrate testing (per `epic-overview` tech-debt notes) shows a single WebTorrent torrent uses noticeable RAM for piece cache + hashing; running 3+ in parallel plus the cast-now stream is the OOM path. 2 lets a user cast one thing and download two in the background — the common case. Users with beefier hardware can raise it. This is exactly the class of tunable that `hardening` A3's `MAX_CONCURRENT_TORRENTS` follow-up covers; align defaults if that lands first.

### 4. Deduplication by hash (fallback: magnet)

**Decision:** Primary dedupe key is the WebTorrent `infoHash` (lowercase). Fallback to the exact magnet string when hash extraction fails.

**Alternatives considered:**
- **Magnet URI only.** Fragile: providers reorder tracker params, some strip DHT flags — same content, different magnet string.
- **IMDb id.** Wrong: multiple releases (1080p / 2160p / different rips) of the same title should be independently queueable.
- **Hash-then-magnet (chosen).**

**Rationale:** `infoHash` is the content-addressed identifier — same file bytes always yield the same hash regardless of magnet formatting. The magnet fallback is for the moment before metadata resolves (extract hash from `xt=urn:btih:` param — a case-fix from the torrent.ts hardening applies here too: lowercase everything). Post-metadata, `setHash()` on the manifest entry canonicalizes to the resolved lowercase hash.

### 5. Retention prune — which of the three approaches

The requirements doc listed three options:
- **(a)** Prune script reads `library.json`, constructs `find … -not -path <p>` args.
- **(b)** Prune script invokes a small server-side helper CLI that outputs the exclusion list.
- **(c)** Reverse — pinned files touched daily to keep mtime fresh so `-mtime +14` never matches.

**Decision:** **(a)** — prune script reads `library.json` directly via `jq`.

**Rationale:**
- **(a)** No extra process, no dependency on Fastify being up when the timer fires (Fastify might crash-restart at 04:00; the prune should still work). `jq` is a 200KB apt install, already common on Ubuntu servers. The script is transparent — an operator can `cat` it and understand what will happen.
- **(b)** Requires the server binary to be built and available on the box, spawns a Node process per prune run (~150ms startup), and couples the timer's success to the server's health.
- **(c)** Clever but wrong: mtime is a proxy for "recently accessed," not "pinned." Touching pinned files daily also breaks any legitimate "when was this last read" question, and races with the prune script's own `-mtime +14` check.

Fail-safe is essential for (a): if the manifest is unreadable, the script exits 0 without deleting anything — never destroy user files on doubt.

### 6. Storage location — reuse `DOWNLOAD_PATH` vs separate library dir

**Decision:** Reuse the existing `DOWNLOAD_PATH`. Library items live alongside cast-now downloads.

**Rationale:** WebTorrent's `client.add(magnet, { path: DOWNLOAD_PATH })` is what the code already does. Adding a `LIBRARY_PATH` split would require code changes in `services/torrent.ts` and would surprise the operator when the same title downloaded via cast-now vs Watch Later ends up in different dirs. The prune script already scopes to `DOWNLOAD_PATH`; the pin-flag exclusion carves out the retention-protected subset. Simpler mental model: one dir, one prune, one exclusion list.

### 7. Pin flag semantics — pin at add-time vs post-completion

**Decision:** Pin is togglable at any state; default `false`. UI exposes the toggle from the moment the item is queued.

**Alternatives considered:**
- **Pin only after completion.** Prevents "pin a queued item before it exists on disk" — but a pinned queued item is fine; the prune only touches files, not manifest entries, so a pinned-but-incomplete entry is a no-op for retention.
- **Auto-pin on add.** Would mean the retention-timer never touches Watch Later titles at all — arguably the safer default, but breaks the "curated library" mental model (the user picks what to keep long-term).

**Rationale:** The default `pinned: false` treats Watch Later as "watch once, let retention handle it" — matches the "temporary queue that becomes a permanent library" spectrum the user can navigate with the pin toggle. Pinning a queued item is legal (no state change until it completes) and lets the user pre-commit before the download finishes.

### 8. Server crash mid-download — resume, not restart

**Decision:** On server boot, `download-queue.ts` reads the manifest and re-spawns any `completedAt === null` item. WebTorrent's on-disk piece store means the download resumes from wherever it stopped, not from zero.

**Rationale:** WebTorrent persists piece hashes + downloaded pieces to `DOWNLOAD_PATH/.<name>` (implementation-dependent but reliable). Re-`client.add(magnet, { path: DOWNLOAD_PATH })` with the pieces already on disk is instantly-at-progress-X; the "done" event fires when the last pieces arrive. No custom checkpointing needed. If WebTorrent's on-disk state is corrupted, the worst case is a fresh re-download of that specific item — not a data-loss.

### 9. Add a helper CLI vs jq for prune script — deferred

The alternative to jq (Key Decision #5) was a Node helper CLI at `apps/server/dist/cli/pinned-paths.js` invoked by the prune script. **Rejected** for v1 (see #5), but noted here so future maintainers know it was considered. Revisit if `jq` ever becomes unavailable or if the manifest schema grows complex enough that a typed helper is safer than a jq expression.

### 10. `WatchLaterLibrary` component vs extending existing `Library.tsx`

**Decision:** New component (`WatchLaterLibrary.tsx`). Do not overload the existing `Library.tsx` modal (which serves active-downloads + history — the `library-settings` feature).

**Rationale:** The existing modal is a *transient audit view* (open, glance, close); the new Library is a *persistent product surface* (route, browse, play). Different UX affordances, different data models (active-torrent state vs completed-download poster grid), different lifecycles. Overloading the existing component would fight both. Coexisting is cheap — two files, one nav slot.

### 11. `POST /api/library/:id/play` returns re-added-torrent stream URL

**Decision:** The play route re-adds the torrent to the WebTorrent client from the on-disk store and returns `/stream/<hash>`. The client redirects to the player which streams from `/stream/<hash>` — the same endpoint that powers cast-now.

**Alternatives considered:**
- **Serve the file directly** via a new `/api/library/:id/file` endpoint. Bypasses WebTorrent entirely — but breaks the shared streaming pipeline (transcoding, byte-range handling, subtitle-track discovery, cast-integration URL shape) that already lives in `/stream/:hash`.

**Rationale:** Reusing `/stream/:hash` means transcoding, subtitle discovery, Chromecast URL construction, and history-append-on-cast-start all "just work." The re-add is instantaneous because WebTorrent sees the pieces already on disk and reports the torrent as `done: true` immediately.

---

## Definition of Done

Every criterion below is testable / observable — an independent evaluator can verify each without reading the code.

### Functional

- [ ] `POST /api/library/queue` with a valid magnet + metadata returns `{ id: <uuid>, alreadyPresent: false }`; a second identical call returns `{ id: <same uuid>, alreadyPresent: true }`.
- [ ] `GET /api/library` returns `{ queued, downloading, completed }` — three arrays, each pre-sorted by `addedAt` desc, every item conforms to the `LibraryItem` shape.
- [ ] Queued items download in the background with no browser tab open and no player attached (verify by queuing → closing browser → waiting → SSH into box and inspecting `library.json` for `completedAt` populated).
- [ ] `library.json` on disk has the correct fields: `id`, `magnet`, `hash`, `title`, `year`, `poster`, `imdbId`, `source`, `addedAt`, `completedAt`, `filePath`, `pinned`. No extra fields; no missing fields.
- [ ] Library UI renders completed items in a poster grid; poster loads; title + year visible.
- [ ] `POST /api/library/:id/play` on a completed item → `GET /stream/<hash>` returns 200 with a `Content-Length` header **immediately** (verify: `curl -I` returns within 100ms; no waiting for peers). Byte-range seek to the end of the file returns 206 with the requested bytes in <500ms.
- [ ] Cast from Library succeeds against Master Llama — playback starts on TV within 30s.
- [ ] `POST /api/library/:id/pin` toggles the `pinned` flag; response is the updated `LibraryItem`.
- [ ] `DELETE /api/library/:id` on a pinned item returns 409 Conflict; on an unpinned completed item returns 204 and the file is gone from `DOWNLOAD_PATH`.

### Retention

- [ ] `scripts/prune-downloads.sh` passes `shellcheck` with no warnings.
- [ ] With a manifest containing 1 pinned file and 1 unpinned file both older than 14 days: running the script deletes the unpinned file, keeps the pinned file.
- [ ] With `library.json` missing: script runs cleanly, prunes based on mtime only (clean-install case).
- [ ] With `library.json` corrupt (truncated / invalid JSON): script logs "unreadable — skipping" and exits 0 without deleting anything.
- [ ] Idempotent: run the script twice; second run has nothing to do.
- [ ] After the real-box run (Phase 8) with 2 pinned items among the 10 completed titles, the 2 pinned items survive a manual prune with old mtimes.

### Concurrency + resilience

- [ ] Two concurrent `POST /api/library/queue` calls for different magnets → both entries land in the manifest (no lost write).
- [ ] Kill the server with `kill -9` mid-download → restart → the same item resumes downloading (verify via `GET /api/torrents` progress increasing).
- [ ] Kill the server with `kill -9` during a `library.json` write → after restart, the manifest is either the pre-write or post-write version (never truncated — atomic-write bar met).
- [ ] `MAX_CONCURRENT_QUEUED=2` is respected: queue 3 items → only 2 appear in `GET /api/torrents` simultaneously; the 3rd starts when either of the first two completes.

### Regressions

- [ ] Cast-now flow unchanged: search a title → click Cast (not Watch Later) → playback on TV. Zero regressions.
- [ ] `GET /api/torrents` still returns active torrents; the WebTorrent client still powers cast-now streams.
- [ ] `history.json` still written on cast start / torrent removal (hardening B3 behaviour preserved).
- [ ] `castcrate-prune.service` still runs nightly (`systemctl list-timers castcrate-prune.timer` shows the next run).
- [ ] Existing `Library.tsx` modal (active downloads + history) still opens and functions.

### Non-goals for DoD (out of scope, documented in Requirements)

- No bandwidth throttling for background downloads.
- No priority queue / reorder.
- No multi-user / per-user libraries.
- No cloud sync.
- No pre-transcoding at completion.
- No completion notifications (push, email).
- No storage-quota auto-eviction.
- No import of pre-existing files.

### Verification method (an evaluator runs these on the deployed box)

1. `ssh castcrate@<box>`.
2. From a LAN laptop browser: open `http://castcrate.local:3000`. Search a well-seeded title. Click "+ Watch Later". Toast confirms.
3. Open Library → item appears in Queue or Downloading. Refresh; state updates. Close the browser.
4. Wait for download (varies by title; typically 10–60 min for a 1–5 GB movie).
5. Reopen Library → item is in Completed with poster + metadata.
6. Click Play → player opens; `curl -I http://<box>:3000/stream/<hash>` from a terminal returns 200 with Content-Length immediately.
7. Seek to 90 % of the video → playback resumes there within 500ms (no peer wait).
8. Cast the same item to Master Llama → TV plays.
9. Pin the item; try Delete → 409 (UI shows toast).
10. Unpin; retry Delete → 204; refresh Library → item gone; on disk the file is gone.
11. On the box: `sudo touch -d "20 days ago" <path-to-a-pinned-completed-file>; sudo touch -d "20 days ago" <path-to-an-unpinned-completed-file>; sudo systemctl start castcrate-prune.service; journalctl -u castcrate-prune -n 30 --no-pager`. Verify: pinned file still exists; unpinned old file is gone.
12. `sudo systemctl restart castcrate; sleep 30; curl -s http://<box>:3000/api/library | jq '.queued | length, .downloading | length, .completed | length'`. Verify: manifest state persisted across restart; any mid-download items resumed.
13. Verify cast-now regression: from Library, click a Completed item's Cast button; from Search, click a fresh result's Cast button. Both work.

Every step is observable — no "check the logs and guess."

---

## Testing Strategy

### Vitest — services

- **`services/__tests__/library.test.ts`** (mock `fs/promises`; write to a temp directory, not `~/.castcrate/`, to keep tests hermetic):
  - `addToQueue` + idempotency + manifest structure.
  - Concurrent write serialization (fire two `addToQueue` calls with `Promise.all` on different magnets; assert both landed).
  - `markCompleted` transitions state.
  - `togglePin` flips + returns updated.
  - `removeItem` refuses pinned unless forced.
  - Corrupt manifest recovery (`writeFile` a truncated JSON string; assert `listLibrary` returns `{ queued: [], downloading: [], completed: [] }` and a subsequent `addToQueue` succeeds).
- **`services/__tests__/download-queue.test.ts`** (mock the WebTorrent surface — return a fake `WtTorrent` with controllable event emitters; mock `services/torrent.ts::startTorrent` at the module boundary):
  - Concurrency cap: 3 queued items with `MAX_CONCURRENT_QUEUED=2` → only 2 active; after one "done" fires, the 3rd activates.
  - "done" event → `markCompleted` invoked with the expected filePath; the torrent is `removeTorrent`d from the client.
  - Error path → item stays queued (no `completedAt` write); scheduleScan called.

### Vitest — route smoke tests (optional but low-cost)

If the codebase already has route-level integration tests, add:
- `POST /api/library/queue` returns 200 + AddToQueueResponse shape.
- `GET /api/library` returns the shape.
- `POST /api/library/:id/pin` on a mocked-existing id returns the updated LibraryItem.

### Manual E2E (Phase 8)

The full end-to-end verification method above. Requires a real box + a Chromecast + patience for 10 downloads. This is the load-bearing test — the promise "queue → walk away → cast tomorrow" cannot be unit-tested.

### Prune script

- `shellcheck scripts/prune-downloads.sh` (add to CI if `shellcheck` is already in the pipeline).
- Local test cases with a temp `DOWNLOAD_PATH` + a temp `library.json`; verify each of the four scenarios in Phase 5 acceptance.

---

## Dependencies

### External

**None.** No new npm dependencies. No new HTTP APIs. No new services.

### Repo coordination

- **`library-settings`** — name-collision risk explicitly handled in Phase 6 (new component `WatchLaterLibrary.tsx`; existing `Library.tsx` modal untouched). The two coexist: modal shows *active + history*; new view shows *queue + downloading + completed*.
- **`hardening`** — matches the atomic-write bar set by B1 (`writeFile('.tmp') → rename`).
- **`omdb-search` + `tmdb-metadata` (planned)** — metadata is captured at add-time from whichever source produced the search result. The manifest stores its own copy so display works when the metadata service is down. Both sources return the same fields we need (`title`, `year`, `poster`, `imdbId`); no per-source branching.
- **`transcoding`** — reused by `POST /api/library/:id/play` via the existing `/stream/:hash` (and `/stream/:hash/transcoded`) endpoints. No changes.
- **`cast-controls` + `chromecast`** — Cast from Library uses the existing `/api/cast/play` handler with the stream URL from the library play response. Zero pipeline changes.
- **`vpn-split-tunnel`** — library playback is 100% local disk read, VPN-independent. Queued downloads run inside the netns like every other outbound in that feature — they inherit the WG route without opt-in.
- **Retention timer (`castcrate-prune.service` in `media-mac-deploy`)** — extended in Phase 5. Adds `jq` to the apt install list; swaps the `ExecStart=` command from the inline `find` to `/opt/castcrate/scripts/prune-downloads.sh`.
- **`torrentday-indexer`** — TorrentDay results include `torrentUrl` (not `magnet`). If the user queues a TD result, the queue-add route needs to convert `torrentUrl` → `.torrent` blob → magnet. **Deferred to a follow-up**: v1 accepts `magnet` only in the request body; the "+ Watch Later" button is disabled for TD results (or we teach the client to fetch the blob first and pass the resulting magnet to the queue). Explicit trade-off — call out in Phase 6 acceptance.

### New docs

- This `implementation.md`.
- `tasks.md` — generated by `/proceed` from this plan's phase list.
- `context.md` — generated during / after implementation.

---

## Risks & Mitigation

### R1. Concurrent `library.json` writes race + corrupt state

**Risk:** `POST /api/library/queue` and `download-queue.markCompleted()` fire near-simultaneously → both load the cache, both mutate different entries, both write back → the later write loses the earlier mutation.

**Mitigation:**
- Module-level `writeLock: Promise<void>` in `services/library.ts` serializes every `save()`. Second caller awaits the first before its own read-modify-write. All mutation goes through this bottleneck.
- Atomic write (`.tmp` + rename) is orthogonal — protects against crash-mid-write, not concurrency.
- Vitest concurrency test in Phase 7 fires `Promise.all([addToQueue(a), addToQueue(b)])` and asserts both entries survive. Locks in the invariant.

### R2. Disk space exhaustion from unbounded queueing

**Risk:** User queues 500 titles; box fills its disk; downloads stall or crash the filesystem.

**Mitigation:**
- v1 explicitly out of scope per requirements — no auto-quota. Documented so operators know.
- Phase 8 acceptance flags this: the 10-title test is a lower bound. If storage fills in practice, follow-up feature adds quota enforcement.
- Mid-term mitigation: retention prune runs nightly and clears unpinned old files. As long as the user's queue rate < prune rate for unpinned items, the disk stays healthy.

### R3. `library.json` corruption via non-atomic write

**Risk:** A crash during `writeFile()` on `library.json` leaves the file half-written; on next load, `JSON.parse` throws; the cache falls back to `[]` and the user's library appears empty.

**Mitigation:**
- Atomic writes (`.tmp` + POSIX rename) — the invariant enforced in Phase 2.
- Startup validation: on load, if the parse throws, log a **warning** (not a silent fallback like `history.ts` — that's called out as a gotcha we should not repeat) and fall back to `[]`. Operator sees the warning and can restore from a backup if they have one.
- Consider (deferred): keep a `library.json.bak` copy after each successful write. YAGNI for v1 — atomic writes are already the bar `hardening` set.

### R4. Pinned file deleted manually — manifest becomes stale

**Risk:** User `rm -rf ~/castcrate-downloads/some-title/` outside CastCrate; the manifest entry still shows `filePath` populated + `completedAt` set + `pinned: true`. Library UI tries to play → 404 from `/stream/<hash>` (or empty stream if WebTorrent re-fetches from swarm — which defeats the "instant local play" promise).

**Mitigation:**
- On server boot, a **startup validator** in `services/library.ts` iterates completed entries and `fs.stat`s each `filePath`. If missing, either (a) mark the entry as stale with a `staleAt: string` field and surface a "file missing" badge in the UI, or (b) auto-remove the manifest entry.
- Pick (a) in v1 — never destroy user metadata based on a stat check (the disk might be temporarily unmounted).
- UI Library section renders "file missing" tiles with a "Delete manifest entry" button.
- Add a Definition-of-Done note to test this: manually `rm` a completed file's on-disk copy, restart the server, verify the entry is flagged in the UI.

### R5. Metadata source down at add-time

**Risk:** User clicks "+ Watch Later" while OMDb / TMDB / Stremio addon is unavailable. The search result already has the metadata (title, year, poster) in the client-side state — but if the client re-fetches for any reason, the add would fail.

**Mitigation:**
- Metadata comes from the *search result object* the client already holds. The `POST /api/library/queue` request body carries the metadata inline; the server does not re-fetch it. So an outage of OMDb *after* the search completed does not block adding to the queue.
- If a metadata field is null (poster unavailable at search time), the manifest stores null; UI degrades gracefully (title-only tile).
- Backfill: a future enhancement could periodically re-fetch metadata for entries with null fields. YAGNI for v1.

### R6. Long-running background downloads on server restart

**Risk:** A queued item at 80% progress. Server crashes. On restart, does the download resume from 80% or restart from 0%?

**Mitigation:**
- WebTorrent's on-disk piece store persists downloaded pieces to `DOWNLOAD_PATH/.<name>` (implementation-dependent but reliable in the v2.x line CastCrate uses).
- On boot, `download-queue.ts::scan()` re-`client.add(magnet, { path: DOWNLOAD_PATH })` — WebTorrent detects the on-disk pieces and reports the torrent at 80% immediately. The remaining 20% downloads normally; the "done" event fires at 100%.
- Verified in Phase 8 acceptance (reboot test).
- Worst case: WebTorrent piece store is corrupted for a specific torrent → re-downloads from 0%. Manifest state is unaffected; no data loss.

### R7. `POST /api/library/:id/play` re-adds a torrent already active

**Risk:** User plays a Library item that happens to still be seeding (or was recently played and not yet garbage-collected from the WebTorrent client). `client.add(magnet)` throws "Cannot add duplicate torrent".

**Mitigation:**
- `services/torrent.ts::startTorrent` already handles this via its duplicate-guard fast path (matches magnet's infoHash against `client.torrents`). Post-hardening lowercase fix confirmed correct.
- Play route simply calls `startTorrent(magnet)`; the shared behaviour applies. No new code needed.

### R8. Startup queue-flood when many items are queued

**Risk:** 50 queued items in the manifest at boot. `scan()` spawns 50 WebTorrent adds simultaneously (before the "active" map fills to `MAX_CONCURRENT_QUEUED`).

**Mitigation:**
- Explicit loop bound in `scan()`: `while (active.size < config.maxConcurrentQueued && queued.length > 0)`. The bound is enforced *inside* the loop before each spawn — the map count is the gate.
- Vitest covers this in Phase 7 (3 items, cap 2).

### R9. Delete-while-downloading race

**Risk:** User deletes an item that's currently downloading. The queue worker has a `done` handler attached that may fire between the delete and the manifest cleanup, calling `markCompleted` on an id that no longer exists.

**Mitigation:**
- `markCompleted(id)` calls `findById(id)` internally; if missing, logs and returns without throwing. The `done` event is a no-op on a deleted entry.
- `DELETE /api/library/:id` invokes `removeTorrent(hash, { destroyStore: true })` first (WebTorrent tears down the torrent and calls its `close` listener) then updates the manifest. The order matters: torrent-first ensures no `done` fires after the manifest entry is gone.
- Vitest race test: fire `deleteLibraryItem(id)` and simulate a `done` event in the same tick; assert no throw and no manifest re-population.

### R10. Prune script pinned-path escaping

**Risk:** A pinned file path contains characters that break the `find -not -path` expansion (spaces, quotes, glob metacharacters). The exclusion silently fails; the pinned file gets deleted.

**Mitigation:**
- `find -path` matches literal path strings — no glob expansion happens by default (unlike shell globbing). Spaces are fine because we quote the argument via bash array expansion (`"${pinned_args[@]}"`).
- Manual test in Phase 5 acceptance: pin a file with a space in its path (`Some Title (2020) [1080p].mkv`); verify it survives the prune.
- If a path contains characters that genuinely confuse `find` (rare — control chars, newlines), the operator can rename the file. Document in the runbook.

### R11. TorrentDay `torrentUrl` vs `magnet` in queue payload

**Risk:** TorrentDay results have `torrentUrl` (private tracker `.torrent` blob URL) but no `magnet`. The queue payload requires `magnet`; queueing a TD result would fail.

**Mitigation:**
- v1: disable the "+ Watch Later" button on TorrentDay results (UI-only), with a tooltip explaining the limitation. Documented in Phase 6 acceptance.
- v1+1: teach the queue route to accept `{ torrentUrl }` as an alternative to `magnet`, fetch the blob server-side, and hand the blob to `startTorrent`. Straightforward extension when TD queueing becomes a stated need.

### R12. Startup validator vs download-queue race

**Risk:** The startup validator (R4) `fs.stat`s completed entries; concurrently the download queue kicks off and starts adding torrents. If a completed entry's file is missing, marking it stale during boot conflicts with an eager play attempt.

**Mitigation:**
- Boot order: validator runs to completion before `startDownloadQueue()`. Both live in the same bootstrap sequence; serialize them.
- Neither operation touches the same manifest fields — validator writes `staleAt`; queue writes `completedAt` / `filePath`. Even a race would not corrupt state.

---

## Quality Bar

- **Atomic writes are the floor, not the ceiling.** `library.json` writes go temp+rename; the mutex ensures no lost writes; corrupted-parse recovers cleanly with a **logged warning** (not silent — the `library-settings` gotcha explicitly calls out silent fallback as bad). If this bar slips, the whole feature breaks the first time the box loses power mid-write.
- **The pin flag is inviolable.** The retention timer CANNOT delete pinned items — that is the whole product promise. Phase 5's fail-safe (skip prune on manifest read failure) is non-negotiable; Phase 8's real-box test proves it live. If a pinned file is ever deleted by prune, the feature is failing its core commitment.
- **Zero regressions on cast-now / search / stream / retention / history.** The new services and routes are purely additive. Existing routes and lifecycles are untouched.
- **Add-to-queue is idempotent.** Double-add is a no-op; the response tells the caller (`alreadyPresent: true`) so the UI can toast "already queued" without confusion.
- **The queue processor shares the WebTorrent client** — no second client instance, no duplicated peer connections, no coordination protocol between two workers. One process, one client, one library file.
- **Playback from Library is instant** — verifiable: `curl -I` on `/stream/<hash>` returns 200 with `Content-Length` inside 100ms; a seek to 90% resolves in <500ms. If either is not true, WebTorrent is not correctly detecting the on-disk pieces as `done` and the "instant seek" promise is failing.
- **The prune script is fail-safe.** Missing manifest → prune anyway (clean-install case). Corrupt manifest → skip prune (never destroy user data on doubt). Empty pinned list → prune everything old. The three states are distinguishable in the journal so the operator can debug.
- **Name collision with `library-settings` is documented and handled.** New component is `WatchLaterLibrary`; existing `Library` modal is untouched. Do not overload names to save keystrokes — the confusion cost across the epic is higher than any brevity gain.
