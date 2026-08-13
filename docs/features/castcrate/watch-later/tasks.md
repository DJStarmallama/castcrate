# watch-later — Task Checklist

**Last Updated:** 2026-08-12
**Progress:** 6/8 phases complete (Phase 6 UI delegated to frontend-dev agent in parallel; Phase 8 real-box deploy is user-driven).

Effort key: <1h S · 1-3h M · >3h L
Phases marked **[max-effort]** are routed to the advanced dev agent.

---

## Phase 1 — Shared types + config plumbing (S)

- [x] Add `LibraryItem`, `LibraryStatus`, `LibraryListResponse`, `AddToQueueRequest`, `AddToQueueResponse`, `LibraryPlayResponse` to `packages/shared/src/index.ts`.
- [x] Add `maxConcurrentQueued` (default 2) to `apps/server/src/lib/config.ts`.
- [x] Add `MAX_CONCURRENT_QUEUED=2` to `.env.example` with doc comment.
- [x] `pnpm -r typecheck` clean.

**Acceptance:** types resolve; config exposes `maxConcurrentQueued`; no behavioural change. Done inline by orchestrator.

---

## Phase 2 — `services/library.ts` — atomic manifest CRUD (M)

- [x] Create `apps/server/src/services/library.ts`. Mirror `history.ts` shape (`HISTORY_DIR` env, `LIBRARY_PATH`, `TMP_PATH`, `ensureDir`, module-level cache).
- [x] Load: hydrate cache from disk on first call, log-warn on corrupt file and fall back to `[]`. Guard non-array parse results.
- [x] Save: temp + rename atomic write; caller must hold `writeLock`.
- [x] `withLock` mutex: chain promises, cover entire load/modify/save cycle (widened from spec — see context.md D1).
- [x] Public API: `load`, `listLibrary`, `findById`, `findByHash`, `findByMagnet`, `addToQueue`, `markDownloading`, `markCompleted`, `setPinned`, `remove`, `__resetLibraryCacheForTests`.
- [x] `addToQueue` dedupe: hash first (extracted from magnet's `xt=urn:btih:`), then exact-magnet fallback. Returns `{ id, alreadyPresent }`.
- [x] `listLibrary` section-split: `hash===null && completedAt===null` → queued; `hash!==null && completedAt===null` → downloading; `completedAt!==null` → completed. Sorted addedAt desc.

**Acceptance:** add + dedupe works; atomic write leaves no .tmp; concurrent adds don't lose writes; corrupt manifest → empty fallback.

---

## Phase 3 — `services/download-queue.ts` — background worker (M) **[max-effort]**

- [x] Create `apps/server/src/services/download-queue.ts`.
- [x] Module state: `active: Map<libraryId, {startedAt}>`, `retries: Map<libraryId, number>`, `scanTimer`, `scanRunning`, `stopped` flags.
- [x] `startDownloadQueueProcessor()`: immediate scan + `setInterval(scan, 30_000).unref()`.
- [x] `stopDownloadQueueProcessor()`: clears timer, sets stopped. Does NOT tear down active torrents (shared client's shutdown handles it).
- [x] `kickDownloadQueue()`: fire-and-forget scan; guarded by `scanRunning`.
- [x] `scan()`: FIFO pop eligible items (completedAt===null && !active && retries<MAX), spawn up to `maxConcurrentQueued`.
- [x] `spawn()`: `startTorrent(magnet)` → `markDownloading(id, hash)` → `getTorrent` → wire `done`/`error`/`close` listeners.
- [x] `onComplete()`: try nested + flat file paths via `fs.stat` (belt-and-braces), `markCompleted(id, absPath)`, `removeTorrent(hash, {destroyStore:false})` (detach only; files stay on disk), free slot, kick.
- [x] Error handling: bump `retries` counter, log warn, free slot, kick. MAX_RETRIES=3 (see context.md D4).
- [x] Boot resume: initial `scan()` picks up any `completedAt===null` items — WebTorrent's on-disk pieces mean downloads resume from where they left off.
- [x] Wire into `apps/server/src/index.ts` bootstrap + onClose.

**Acceptance:** concurrency cap respected; done triggers markCompleted + detach; error frees slot without corrupting manifest; boot resume works; retry ceiling stops runaway workers.

---

## Phase 4 — Routes: `/api/library/*` (S-M)

- [x] Create `apps/server/src/routes/library.ts`.
- [x] `POST /api/library/queue`: validate magnet + metadata; call `addToQueue`; `kickDownloadQueue()`; return `{ id, alreadyPresent }`.
- [x] `GET /api/library`: return `listLibrary()`.
- [x] `DELETE /api/library/:id`: 404 if missing; `removeTorrent(hash, {destroyStore:true})` when hash set; `unlink(filePath)` + `rmdir(dirname)` best-effort; call `remove()`; 204. (Note: no 409-on-pinned — see context.md D2.)
- [x] `POST /api/library/:id/pin`: body `{ pinned: boolean }`; validate; call `setPinned`; 204.
- [x] `POST /api/library/:id/play`: 404 if missing; 409 if not completed; return `{ streamUrl, hash }`. (Client re-adds torrent via existing `/api/torrent/start` if needed — see context.md D3.)
- [x] Register `libraryRoutes(app)` in bootstrap alongside other routes.

**Acceptance:** POST queue → 200 with dedupe; GET returns three sections; DELETE removes file + entry; pin toggles flag; play returns URL for completed items.

---

## Phase 5 — Retention prune extension (M) **[max-effort]**

- [x] Write `scripts/prune-downloads.sh` (bash, `set -euo pipefail`, absolute paths). Reads `~/.castcrate/library.json` via `jq`; builds pinned-paths list; deletes files older than `RETENTION_DAYS` (default 14) via `find`; excludes pinned via `grep -Fxq -f pinned-list-file` (avoids the fragile `-not -path` chain).
- [x] Fail-safe: missing manifest → prune normally (clean-install case); corrupt/unreadable manifest → **exit 1 without deleting anything**.
- [x] Summary log: `[prune] summary: found=N skipped=K deleted=M`; per-file `DELETE` / `SKIP (pinned)` lines.
- [x] `bash -n` clean; smoke-tested locally (pinned survives, corrupt manifest fails safe).
- [x] Update `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 7 with a new "7.6" runbook section: install `jq`, copy script to `/opt/castcrate/scripts/`, swap `ExecStart=` in `castcrate-prune.service`, add `EnvironmentFile=`, verify pin behaviour + fail-safe.

**Acceptance:** script exits 0 on happy path; corrupt manifest → exit 1 no deletes; pinned file survives even with old mtime; runbook update points at the new script.

---

## Phase 6 — UI: Library view + "+ Watch Later" + nav link (M)

**Delegated to frontend-dev agent in parallel. Not this session's scope.** UI contract summary:

- [ ] Client API in `apps/web/src/lib/api.ts`: `addToQueue`, `library`, `playLibraryItem`, `pinLibraryItem`, `deleteLibraryItem`.
- [ ] `WatchLaterLibrary.tsx` — three-section view (Queue → Downloading → Completed), poller `refetchInterval: 2000` for Downloading.
- [ ] "+ Watch Later" button in `TorrentPicker.tsx` (or the current search-result-actions component).
- [ ] Nav "Library" link → route `/library`.
- [ ] Poster grid for Completed; list layout for Queue + Downloading; pin toggle icon; delete-of-pinned gated behind UI confirmation.

**Handoff pointer for frontend agent:**
- Server API is live per Phase 4 above.
- **`queued` section on the server response is usually empty** — items with valid btih magnets skip straight to `downloading` because hash is extracted at add-time (see context.md Gotcha #1). Render "Downloading" as the just-added bucket; "Queued" only shows for edge-case magnets without btih xt.
- Pin flag is decorative on the server — actual retention protection lives in the shell script. UI can trust `pinned: true` in the payload to disable/warn the delete button.
- Play flow: `POST /api/library/:id/play` → `{ streamUrl, hash }`; client should then `POST /api/torrent/start { magnet: <from library item> }` (idempotent, safe if already attached) then navigate to `/player?hash=<hash>`.

---

## Phase 7 — Unit tests (S-M)

- [x] `apps/server/src/services/__tests__/library.test.ts` (16 tests):
  - Empty init; addToQueue defaults; dedupe by hash; dedupe by magnet; distinct entries by different hashes; findById/Hash/Magnet.
  - markDownloading (queued → downloading transition); markCompleted (fills completedAt + filePath); setPinned; remove; listLibrary sorting.
  - Atomic write (no .tmp left behind); mutex — concurrent addToQueue for two magnets both land; mutex — add + markCompleted race both mutations survive.
  - Corruption recovery (invalid JSON → empty; non-array → empty).
- [x] `apps/server/src/services/__tests__/download-queue.test.ts` (8 tests):
  - Concurrency cap respected (3 items with cap=2 → 2 spawn); advancement after done.
  - Done triggers markCompleted + detach `destroyStore:false`; startTorrent error frees slot; torrent 'error' event frees slot without manifest corruption; MAX_RETRIES ceiling parks the item.
  - Boot resume picks up completedAt===null items; skips already-completed.
- [x] Full server suite: **309 passing** (was 285); +24 tests.

**Acceptance:** vitest green; no regressions in the 285 pre-existing tests.

---

## Phase 8 — Real-box deployment + E2E verification (M) **[max-effort]**

**User-driven. Not this session's scope.** Runbook lives in `docs/features/castcrate/media-mac-deploy/tasks.md` sections 7.6.1 - 7.6.6.

- [ ] `sudo apt install -y jq` on the box.
- [ ] `scp scripts/prune-downloads.sh castcrate@<box>:/tmp/ && sudo mv /tmp/prune-downloads.sh /opt/castcrate/scripts/ && sudo chmod 755 /opt/castcrate/scripts/prune-downloads.sh`.
- [ ] Edit `/etc/systemd/system/castcrate-prune.service`: swap `ExecStart=` to the new script; add `EnvironmentFile=/home/castcrate/castcrate/apps/server/.env`; preserve sandbox flags.
- [ ] `sudo systemctl daemon-reload && sudo systemctl start castcrate-prune.service` (clean library → no-op exit 0).
- [ ] Fail-safe verification: corrupt manifest → service reports `failed` (exit 1) via `systemctl status`.
- [ ] Pin verification: pin a real Watch Later item, age its file with `sudo touch -d "20 days ago"`, run prune, file survives.
- [ ] E2E: queue 10 titles → walk away → verify all complete → pin 2 → prune → pinned survive → cast one from library.

**Acceptance:** all criteria in `implementation.md` DoD section pass on the real box.

---

## Bugs & Issues

**Active Bugs:**
- None.

**Fixed Bugs:**
- Lost-write race in `library.ts` addToQueue when called concurrently — caught by test, fixed by widening mutex scope (context.md D1).

---

## Technical Debt

- MAX_RETRIES=3 hardcoded — could become env-tunable if real-box data proves 3 is wrong.
- Play route delegates torrent re-attach to the client — could server-side-side-effect it later if the client contract becomes awkward.
- Empty `queued` section is a quirk of eager hash extraction — could be documented in the API surface if it confuses future consumers.

---

## Documentation Tasks

- [x] Update `implementation.md` status header (Planning → In Progress).
- [x] Create `context.md`.
- [x] Create `tasks.md` (this file).
- [x] Update `docs/features/castcrate/media-mac-deploy/tasks.md` Phase 7 with the pin-aware prune runbook section.

---

## Task Status Legend

- [ ] Not started
- [ ] In progress
- [ ] Blocked (waiting on something)
- [x] Completed
- [x] Cancelled/Won't do

---

## Progress Tracking

### Completed This Session (2026-08-12)
- Phase 1 (orchestrator, inline)
- Phase 2 — services/library.ts
- Phase 3 — services/download-queue.ts (max-effort)
- Phase 4 — routes/library.ts + bootstrap wiring
- Phase 5 — scripts/prune-downloads.sh + media-mac-deploy runbook update (max-effort)
- Phase 7 — 24 new tests (16 library + 8 download-queue)
- Context + tasks docs authored.

### Delegated in Parallel
- Phase 6 — frontend-dev agent (UI).

### Deferred
- Phase 8 — user-driven real-box deployment.

---

*Update this file as tasks are completed.*
