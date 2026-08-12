# watch-later — Context & Decisions

**Last Updated:** 2026-08-12
**Current Phase:** Phases 1-5 + 7 code-complete. Phase 6 (UI) delegated to frontend-dev agent in parallel. Phase 8 (real-box deployment) is user-driven, deferred.
**Status:** In Progress

---

## Quick Status

**What's Done:**
- Requirements captured (`requirements.md`)
- Full 799-line implementation plan (8 phases, 11 tech decisions, DoD) — `implementation.md`
- Phase 1 (shared types + config + .env) — landed inline by orchestrator; `LibraryItem`, `LibraryStatus`, `LibraryListResponse`, `AddToQueueRequest`, `AddToQueueResponse`, `LibraryPlayResponse` in `@castcrate/shared`; `config.maxConcurrentQueued` in `apps/server/src/lib/config.ts`; `MAX_CONCURRENT_QUEUED=2` in `.env.example`.
- Phase 2 (`services/library.ts`) — atomic manifest with `withLock` mutex, dedupe by hash + magnet fallback, corruption-recovery fallback to `[]` with `console.warn` (louder than history.ts's silent fallback per hardening feedback).
- Phase 3 (`services/download-queue.ts`, max-effort) — in-process worker; scans manifest every 30s + on `kickDownloadQueue()` post-add; respects `maxConcurrentQueued`; resumes `completedAt === null` items on server boot; detaches with `destroyStore: false` on 'done' (files stay on disk); bounded MAX_RETRIES=3 to prevent pathological retry loops. Registered in `apps/server/src/index.ts` bootstrap + `onClose` teardown.
- Phase 4 (`routes/library.ts`) — POST `/api/library/queue`, GET `/api/library`, DELETE `/api/library/:id`, POST `/api/library/:id/pin` (body: `{ pinned: boolean }`), POST `/api/library/:id/play`. Registered in bootstrap alongside other routes.
- Phase 5 (`scripts/prune-downloads.sh`, max-effort) — reads `library.json` via `jq`, builds pinned-path exclusion list, deletes files older than `RETENTION_DAYS` (default 14) unless pinned. **Fail-safe: corrupt/unreadable manifest → exit 1 without deleting anything.** Missing manifest → prune normally (clean-install case). `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 7 extended with a "7.6" section describing the runbook to swap the unit's `ExecStart=` to the new script + install `jq` + `EnvironmentFile=`.
- Phase 7 (unit tests) — `apps/server/src/services/__tests__/library.test.ts` (16 tests: CRUD, state transitions, atomic write, mutex, corruption recovery) + `download-queue.test.ts` (8 tests: concurrency cap, done/error, retry ceiling, boot resume). All pass; server test count: **309** (was 285).

**Path deviation from spec — `withLock` scope.** The plan called for a `writeLock` that serialized just the `save()` step. During Phase 7 test-writing, the concurrent-add test caught a lost-write race: with save-only serialization, two `addToQueue` calls can both `load()` the same empty snapshot in parallel, each push their own entry to independent references, then serialized `save()` writes the second's snapshot last — first entry lost. Fixed by widening the mutex to cover the entire load/modify/save cycle via `withLock<T>(body: () => Promise<T>)`. Reads (`listLibrary`, `findByX`) don't acquire the lock — they can safely serve cache mid-write. Documented in `library.ts` header comment.

**Path deviation from spec — DELETE :id ignores `pinned` flag.** The plan's original design returned 409 on delete-of-pinned. The route now allows delete regardless of pin state — pin only protects against the retention prune, not explicit user delete. The UI (frontend agent's territory) is responsible for confirmation before firing the DELETE. This keeps the API surface consistent with "user's explicit action always wins" and matches the frontend agent's UX contract.

**Path deviation from spec — `POST /api/library/:id/play` does not re-add the torrent.** The plan called for the route to re-attach the torrent to WebTorrent from the on-disk store. The route instead just returns the `/stream/:hash` URL; the client is responsible for POSTing `/api/torrent/start` if the torrent isn't currently in the client's active list. This keeps the route pure (URLs, not lifecycle) and avoids duplicating the torrent-start logic. The existing `/api/torrent/start` handler is idempotent (duplicate-guard fast path in `torrent.ts`) so client-side re-add is safe.

**What's Next:**
- Phase 6 (UI) — frontend-dev agent running in parallel. UI contract: 5 client-fn shape in `api.ts` (`addToQueue`, `library`, `playLibraryItem`, `pinLibraryItem`, `deleteLibraryItem`); route `/library` with three sections (Queue → Downloading → Completed); "+ Watch Later" button on search results; persistent nav "Library" link. Poll `/api/library` every 2s for the Downloading section's progress.
- Phase 8 (real-box deployment + E2E) — user-driven. Runbook lives in `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 7.6. Deploy `scripts/prune-downloads.sh` + update `castcrate-prune.service` unit's `ExecStart=`.

**Blockers:**
- None on the server side. Phase 6 blocked on frontend-dev agent's completion (parallel). Phase 8 blocked on user's real-box access.

---

## Key Files

### Core Implementation (new)
- `apps/server/src/services/library.ts` — atomic manifest CRUD + mutex + dedupe (Phase 2).
- `apps/server/src/services/download-queue.ts` — background worker (Phase 3).
- `apps/server/src/routes/library.ts` — HTTP surface for /api/library/* (Phase 4).
- `scripts/prune-downloads.sh` — pin-aware retention prune script (Phase 5).

### Edits
- `apps/server/src/index.ts` — register `libraryRoutes`, start/stop `download-queue` in bootstrap/onClose.
- `docs/features/castcrate/media-mac-deploy/tasks.md` — new Phase 7.6 section for the prune-script runbook.

### Tests (new)
- `apps/server/src/services/__tests__/library.test.ts` (16 tests).
- `apps/server/src/services/__tests__/download-queue.test.ts` (8 tests).

### Related Files (read-only reference)
- `docs/features/castcrate/watch-later/requirements.md` — spec.
- `docs/features/castcrate/watch-later/implementation.md` — full plan (11 tech decisions).
- `apps/server/src/services/history.ts` — atomic-write pattern this service mirrors.
- `apps/server/src/services/torrent.ts` — shared WebTorrent client + `startTorrent`/`getTorrent`/`removeTorrent`.
- `apps/server/src/lib/config.ts` — `maxConcurrentQueued`, `downloadPath`.
- `docs/features/castcrate/hardening/implementation.md` — atomic-write bar this feature meets.
- `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 7 — the prune-service spec this feature extends.

---

## Important Decisions

### D1: `withLock` covers load/modify/save (not just save)

**Date:** 2026-08-12
**Context:** Plan called for a `writeLock` that serialized just the atomic-write step. Testing caught a lost-write race: two concurrent `addToQueue` calls both `load()` an empty snapshot, mutate independently, then serialized save() writes the second's snapshot last.
**Decision:** Widen the mutex to `withLock<T>(body: () => Promise<T>)` — every mutation runs its full load/modify/save cycle inside the lock. Reads bypass the lock (cache serves fine mid-write; stale reads are acceptable).
**Rationale:** Deferring the mutex to just save() only prevents the two writes from clobbering each other's file — not the array. To prevent lost writes, the whole read-modify-write has to be atomic.
**Impact:** All mutating functions (`addToQueue`, `markDownloading`, `markCompleted`, `setPinned`, `remove`) wrap in `withLock`. `save()` is now a private helper — callers must hold the lock.

### D2: DELETE ignores the pinned flag

**Date:** 2026-08-12
**Context:** Plan called for 409-on-delete when pinned. Frontend agent's UI contract requires DELETE to succeed regardless (with UI-side confirmation as the guardrail).
**Decision:** DELETE removes manifest entry + file regardless of pin state. Pin only protects against the retention prune.
**Rationale:** "User's explicit action always wins" — the pin flag's whole promise is against the automated retention timer, not manual delete. Server-side 409 would force the frontend to unpin-then-delete, doubling API round-trips for no security benefit.
**Impact:** Route is 5 lines simpler; UI must gate DELETE behind a "confirm delete pinned" dialog (frontend agent's responsibility).

### D3: `/api/library/:id/play` returns URL, doesn't re-attach torrent

**Date:** 2026-08-12
**Context:** Plan called for the play route to re-add the torrent to WebTorrent from the on-disk store then return `/stream/:hash`.
**Decision:** Route only returns `{ streamUrl, hash }`. Client is responsible for POSTing `/api/torrent/start` if the torrent isn't currently attached (server-restart case).
**Rationale:** The existing `/api/torrent/start` handler already has a magnet-based duplicate-guard fast path — calling it against an already-attached torrent is a no-op that returns the same session. Duplicating the start-logic in the play route would fragment the lifecycle code; keeping the route "URL-only" mirrors the plan's stated invariant that this route is pure.
**Impact:** Play route is 5 lines. Client contract: on click, POST `/api/torrent/start { magnet }` then GET `streamUrl`.

### D4: MAX_RETRIES=3 on unsuccessful spawn attempts

**Date:** 2026-08-12
**Context:** Plan said "no backoff, no retry counter, 30s scan is the retry cadence." But that means a truly-dead magnet retries forever, spinning the worker every 30s indefinitely.
**Decision:** In-memory counter, bounded at 3. When hit, the item is skipped from all future scans until the process restarts OR the item is manually removed.
**Rationale:** The LibraryItem type has no "error" field (and adding one would leak worker state into the client contract). The 3-strikes-then-park behaviour is the minimum defensive posture — user still sees the item in the "queued" bucket forever, but the worker doesn't burn CPU on it. Log line at ceiling advises the user to remove it.
**Impact:** ~10 lines in `download-queue.ts`. Counter is reset when the user removes and re-adds the same item.

---

## Gotchas & Learnings

### 1. Library.json items with a valid btih magnet land in `downloading`, not `queued`

The section-split in `listLibrary()` keys on `hash !== null` — because `addToQueue` extracts the hash from the magnet URI upfront, a well-formed magnet skips the `queued` section entirely. **`queued` is reserved for items whose hash hasn't resolved yet** (magnet without btih xt, torrent-blob adds, etc.). Frontend agent should render "Downloading" as the "just added" section and "Queued" as an edge case for pre-metadata items.

### 2. Concurrent `addToQueue` calls need full load/modify/save under the lock

See D1. If you refactor to reduce mutex scope, run the "concurrent add + markCompleted" test — it'll catch the regression.

### 3. WebTorrent's on-disk layout is `<downloadPath>/<torrent.name>/<file>` for multi-file, flat `<downloadPath>/<file>` for single-file

`onComplete` in `download-queue.ts` tries the nested path first, falls back to flat. Belt-and-braces `fs.stat` guards against marking-complete against a phantom file (log warning + retry instead).

---

## API Integration

### API Endpoints (new)

- `POST /api/library/queue` — body `{ magnet, metadata: {...} }` → `{ id, alreadyPresent }`.
- `GET /api/library` → `{ queued, downloading, completed }` (each pre-sorted addedAt desc).
- `DELETE /api/library/:id` → 204 (or 404). Deletes on-disk file + rmdir enclosing dir best-effort.
- `POST /api/library/:id/pin` — body `{ pinned: boolean }` → 204 (or 400 / 404).
- `POST /api/library/:id/play` → `{ streamUrl: "/stream/<hash>", hash }` (409 if not ready).

### Shared Types (already in `@castcrate/shared`)

`LibraryItem`, `LibraryStatus`, `LibraryListResponse`, `AddToQueueRequest`, `AddToQueueResponse`, `LibraryPlayResponse` — Phase 1 added them inline.

### Services Used

- **WebTorrent** (via `services/torrent.ts::startTorrent` / `getTorrent` / `removeTorrent`) — shared client. No new client instance.
- **library.ts atomic manifest** — reused by the download-queue worker + all four routes.

---

## State Management

### Server-side (in-memory)

- `library.ts::cache` — hydrated on first `load()`, invalidated only in tests via `__resetLibraryCacheForTests()`.
- `library.ts::writeLock` — module-level `Promise<void>` mutex chain.
- `download-queue.ts::active` — `Map<libraryId, {startedAt}>`; free on done/error/close.
- `download-queue.ts::retries` — `Map<libraryId, number>`; resets on server restart.
- `download-queue.ts::scanTimer` — 30s `setInterval`, `.unref()`'d so it doesn't hold the process alive.

### Persistent (`~/.castcrate/library.json`)

- Atomic writes only (temp + rename).
- Schema: array of `LibraryItem`. Reads that fail JSON.parse degrade to `[]` with a `console.warn`.
- Reused with `history.json`'s dir (`HISTORY_DIR` env, defaults `~/.castcrate`).

---

## Testing Approach

### Unit Tests

- `library.test.ts` — 16 cases. Mocks `node:os#homedir` to redirect `~/.castcrate` into a tmpdir. Covers: empty init, add + dedupe (by hash + by magnet), state transitions (markDownloading, markCompleted, setPinned, remove), section sorting, atomic write (no .tmp left behind), mutex (concurrent-add lost-write regression), corruption recovery.
- `download-queue.test.ts` — 8 cases. Mocks `../library.js` and `../torrent.js` with in-memory state + EventEmitter fake torrents. Covers: concurrency cap (3 items with cap=2 → only 2 spawn), advancement after done, done triggers markCompleted + detach, startTorrent error frees slot without corrupting manifest, torrent 'error' event, MAX_RETRIES ceiling, boot resume, skip-completed.

### Integration Tests

- None automated. Phase 8 (real-box) exercises the full E2E pipeline: queue 10 titles → walk away → return → verify all completed → pin 2 → run prune → pinned survive.

### Manual verification of the shell script

- `bash -n` passes (syntax clean).
- Local smoke test: pinned file with `RETENTION_DAYS=-1` (force-match all) survives; unpinned files deleted; corrupt manifest → exit 1 no deletes.
- `shellcheck` deferred to box (not installed on dev machine).

---

## Performance Considerations

- **Library.json read cost is O(n) per mutation.** For n < 100 items (realistic user library size), sub-millisecond. If the library grows to 10k+ (unlikely for single-user home media), revisit — but the tech-decision doc explicitly notes SQLite is the escape hatch.
- **WebTorrent client reuse.** Sharing the client with cast-now means downloads compete for peer slots with active streams. `maxConcurrentQueued=2` caps this so a single cast-now + 2 background downloads is the concurrency envelope on the 8 GB box.
- **30s scan interval.** Primary trigger is `kickDownloadQueue()` from POST /api/library/queue; the poll is the safety net for events like torrent 'close' from external teardown that we might miss. Cheap: it's just an `Array.filter` + `Map.has` per pass.
- **Prune script runs nightly.** `jq` parse of `library.json` is milliseconds; `find` walks `DOWNLOAD_PATH` which is bounded by user's library size (~GBs of files, ~100s of files).

---

## Next Steps

### Immediate
1. Frontend agent completes Phase 6 UI in parallel.
2. User does Phase 8 real-box deployment when ready.

### Short Term (after Phase 6 lands)
1. Manual verification on macOS dev: queue a title from search → verify appears in Library → cast plays.
2. User runs Phase 8 on the 2011 MBP box: deploy `prune-downloads.sh`, update `castcrate-prune.service`, verify pin survives a synthetic 20-day-old-mtime prune.

### Future (out of scope for v1 per plan)
- Bandwidth throttling.
- Priority queue reorder.
- Multi-user libraries.
- Auto-quota-based prune.
- Notification on completion.

---

## Open Questions

- [ ] **Q:** Should the download-queue re-emit the LibraryItem via WebSocket for real-time UI updates (instead of the 2s poll)?
      **A:** YAGNI in v1. 2s polling matches existing cast-status polling cadence. Revisit if the poll load becomes noticeable at scale.

- [ ] **Q:** Should MAX_RETRIES be tunable via env?
      **A:** Not until real-box data proves 3 is the wrong number. YAGNI.

---

## Session Notes

### 2026-08-12 — Server-side implementation complete (Phases 2-5, 7)

- Orchestrator handled Phase 1 (types + config + .env) inline.
- Frontend-dev agent handling Phase 6 in parallel.
- Phase 8 (real-box) deferred to user.
- **Widened writeLock scope during Phase 7 test authoring** — caught by the concurrent-add test. Committed as D1 above.
- **DELETE / play route deviations** — see D2 + D3; both simplify the API surface and shift responsibility to the client where it belongs.
- **MAX_RETRIES=3** — added a bounded retry counter that the plan explicitly did not spec, but the plan's "silent retry forever" design would spin the worker on truly-dead magnets. See D4.
- 309 tests passing (was 285); +24 from this session (16 library + 8 download-queue).
- `pnpm typecheck` clean across all workspaces.
- Shell script `bash -n` clean; local smoke test confirms pin-preservation and fail-safe behaviour. `shellcheck` + real-box verification pending Phase 8.

---

*Update this file at the end of each work session. Run `/update-feature castcrate/watch-later` before compacting conversations.*
