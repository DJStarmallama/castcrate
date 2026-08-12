/**
 * download-queue.ts — background worker that drives Watch Later items to
 * completion using the shared WebTorrent client (services/torrent.ts).
 *
 * Design notes:
 *
 * - Reuses the SAME WebTorrent client cast-now uses. No second client → no
 *   duplicate torrents, halved peer footprint, no OOM path on the 2011 MBP
 *   box (8 GB RAM). See watch-later Key Decision #2.
 *
 * - Concurrency bookkeeping is a Map keyed by libraryId (not infoHash) so
 *   we can start a queue slot for a magnet BEFORE metadata resolves — the
 *   infoHash is unknown at spawn time; markDownloading() writes it in once
 *   startTorrent() resolves.
 *
 * - Errors do not mark the manifest as errored — the LibraryItem type has
 *   no error field, and adding one would leak worker state into the client
 *   contract. Instead: log a warning, leave completedAt null, and let the
 *   30s scan tick pick it up on the next pass. Effectively silent retry
 *   until the user removes it manually. Bounded per-item retry count
 *   (MAX_RETRIES) prevents pathological infinite retry loops for magnets
 *   the swarm truly can't resolve.
 *
 * - Boot recovery: startDownloadQueueProcessor() reads the manifest and
 *   resumes any completedAt === null items (subject to the concurrency
 *   cap). WebTorrent's on-disk piece store means half-finished downloads
 *   resume from the byte they stopped at.
 *
 * - Detach on completion: once torrent 'done' fires and markCompleted has
 *   persisted the filePath, we call removeTorrent(hash, { destroyStore: false })
 *   so the WebTorrent client releases its bookkeeping. Files stay on disk
 *   (that's the whole point of the feature). Not detaching would leave every
 *   completed torrent seeding forever and eventually OOM the box.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../lib/config.js";
import {
  load,
  markCompleted,
  markDownloading,
} from "./library.js";
import {
  getTorrent,
  removeTorrent,
  startTorrent,
} from "./torrent.js";

// Guard against pathological infinite retry loops for magnets the swarm
// can't resolve. Once hit, the worker stops picking the item up; user must
// remove it (DELETE /api/library/:id) to reset. Cheap in-memory counter —
// resets on server restart, which is fine (a restart is itself a signal
// the user wants to try again).
const MAX_RETRIES = 3;
const SCAN_INTERVAL_MS = 30_000;

const active = new Map<string, { startedAt: number }>();
const retries = new Map<string, number>();
let scanTimer: NodeJS.Timeout | null = null;
let scanRunning = false;
let stopped = false;

/**
 * Boot the worker. Called from server bootstrap after routes register.
 * - Immediately runs one scan pass so any items with completedAt === null
 *   at boot time (e.g. server crashed mid-download) resume within the
 *   MAX_CONCURRENT_QUEUED budget.
 * - Schedules a 30s poll as the safety net; the primary trigger is
 *   kickDownloadQueue() from POST /api/library/queue.
 */
export function startDownloadQueueProcessor(): void {
  stopped = false;
  // Fire once immediately, then poll. Wrap the sync call in a Promise.resolve
  // so any load() rejection surfaces as a logged warning rather than an
  // unhandled promise on bootstrap.
  scan().catch((err) => {
    console.warn(
      "[download-queue] boot scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  });
  scanTimer = setInterval(() => {
    scan().catch((err) => {
      console.warn(
        "[download-queue] scheduled scan failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, SCAN_INTERVAL_MS);
  // Don't keep the process alive just for the timer.
  scanTimer.unref();
}

/**
 * Graceful shutdown. Cancels the poll timer; does NOT tear down in-flight
 * torrents (they belong to the shared client, which its own shutdown() hook
 * will destroy). In-flight markCompleted awaits resolve naturally.
 */
export async function stopDownloadQueueProcessor(): Promise<void> {
  stopped = true;
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

/**
 * Wake the worker immediately. Called by POST /api/library/queue after a
 * successful add. Idempotent — if a scan is already running, this call is
 * effectively a no-op (the guard inside scan() serializes passes).
 */
export function kickDownloadQueue(): void {
  if (stopped) return;
  scan().catch((err) => {
    console.warn(
      "[download-queue] kicked scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  });
}

/**
 * Main loop. Reads the manifest, filters queued items, spawns torrent adds
 * up to the concurrency cap. Guarded by `scanRunning` so overlapping calls
 * (30s poll + a burst of kicks) don't double-spawn.
 */
async function scan(): Promise<void> {
  if (scanRunning || stopped) return;
  scanRunning = true;
  try {
    const items = await load();
    // FIFO by addedAt. Filter out anything already complete, already active
    // in the worker, or over the retry ceiling.
    const eligible = items
      .filter(
        (i) =>
          i.completedAt === null &&
          !active.has(i.id) &&
          (retries.get(i.id) ?? 0) < MAX_RETRIES,
      )
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));

    for (const item of eligible) {
      if (active.size >= config.maxConcurrentQueued) break;
      // Fire-and-forget — spawn() manages its own lifecycle and errors.
      spawn(item.id, item.magnet).catch((err) => {
        console.warn(
          `[download-queue] spawn crashed for ${item.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  } finally {
    scanRunning = false;
  }
}

/**
 * Start a single library item: call startTorrent(), persist the resolved
 * infoHash, wire up done/error listeners. Every terminal path frees the
 * concurrency slot and re-kicks the scanner.
 */
async function spawn(id: string, magnet: string | null): Promise<void> {
  if (!magnet) {
    // No magnet on the manifest entry (shouldn't happen via AddToQueueRequest
    // which requires magnet, but the type allows null for .torrent-blob
    // items). Treat as an error retry.
    console.warn(
      `[download-queue] item=${id} has no magnet — skipping`,
    );
    bumpRetries(id);
    return;
  }

  active.set(id, { startedAt: Date.now() });
  try {
    // startTorrent() blocks until metadata resolves (60s timeout inside
    // torrent.ts). Once it returns we have the infoHash.
    const session = await startTorrent(magnet);
    await markDownloading(id, session.infoHash);

    const torrent = await getTorrent(session.infoHash);
    if (!torrent) {
      // Very unlikely — startTorrent just added it and we immediately look
      // it up. Log and let the next scan retry.
      console.warn(
        `[download-queue] item=${id} hash=${session.infoHash}: torrent vanished immediately after add`,
      );
      bumpRetries(id);
      active.delete(id);
      kickDownloadQueue();
      return;
    }

    // If the torrent is already done (WebTorrent resumed from an existing
    // on-disk store — server-restart case) fire the completion path
    // immediately.
    if (torrent.done) {
      await onComplete(id, session.infoHash, session.name, session.videoName);
      return;
    }

    torrent.once("done", () => {
      // Fire-and-forget the completion side-effects; any errors get logged
      // and the retry counter bumped.
      onComplete(id, session.infoHash, session.name, session.videoName).catch(
        (err) => {
          console.warn(
            `[download-queue] item=${id} onComplete failed:`,
            err instanceof Error ? err.message : String(err),
          );
          bumpRetries(id);
          active.delete(id);
          kickDownloadQueue();
        },
      );
    });

    torrent.once("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[download-queue] item=${id} torrent error:`, msg);
      bumpRetries(id);
      active.delete(id);
      kickDownloadQueue();
    });

    torrent.once("close", () => {
      // Covers external teardown (removeTorrent from a DELETE, client destroy
      // at shutdown, etc.). Only free the slot if we haven't already done so
      // via done/error.
      if (active.has(id)) {
        active.delete(id);
        kickDownloadQueue();
      }
    });
  } catch (err) {
    // startTorrent() failed — metadata timeout, invalid magnet, etc.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[download-queue] item=${id} startTorrent failed:`, msg);
    bumpRetries(id);
    active.delete(id);
    kickDownloadQueue();
  }
}

/**
 * Torrent completion path: verify the file exists on disk, persist to the
 * manifest, detach from the client. On any failure we bump the retry counter
 * — better to try again than mark it complete against a phantom file.
 */
async function onComplete(
  id: string,
  infoHash: string,
  torrentName: string,
  videoName: string,
): Promise<void> {
  // WebTorrent's on-disk layout is <downloadPath>/<torrent.name>/<file>.
  // For a single-file torrent, torrent.name === videoName (no enclosing
  // directory). Try the nested path first, fall back to the flat path.
  const nestedPath = join(config.downloadPath, torrentName, videoName);
  const flatPath = join(config.downloadPath, videoName);

  let resolvedPath: string | null = null;
  try {
    await stat(nestedPath);
    resolvedPath = nestedPath;
  } catch {
    // Fall through.
  }
  if (resolvedPath === null) {
    try {
      await stat(flatPath);
      resolvedPath = flatPath;
    } catch {
      // Fall through.
    }
  }

  if (resolvedPath === null) {
    // File isn't where we expected — treat as an error retry rather than
    // marking the manifest complete against a missing file.
    console.warn(
      `[download-queue] item=${id} hash=${infoHash}: 'done' fired but no file at ${nestedPath} or ${flatPath}`,
    );
    bumpRetries(id);
    active.delete(id);
    kickDownloadQueue();
    return;
  }

  await markCompleted(id, resolvedPath);

  // Detach the torrent — files stay on disk (destroyStore: false), the
  // WebTorrent client releases its bookkeeping. Wrap in try because
  // removeTorrent is idempotent but a network error during tracker
  // announce-stop shouldn't prevent us from freeing the slot.
  try {
    await removeTorrent(infoHash, { destroyStore: false });
  } catch (err) {
    console.warn(
      `[download-queue] item=${id} removeTorrent (detach) failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Reset retry counter on success — if the user re-queues the same magnet
  // later after removing, the counter starts fresh anyway (item is gone).
  retries.delete(id);
  active.delete(id);
  kickDownloadQueue();
}

function bumpRetries(id: string): void {
  const current = retries.get(id) ?? 0;
  retries.set(id, current + 1);
  if (current + 1 >= MAX_RETRIES) {
    console.warn(
      `[download-queue] item=${id} hit MAX_RETRIES=${MAX_RETRIES}; will not retry until server restart or manual removal`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function __resetDownloadQueueForTests(): void {
  stopped = true;
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  scanRunning = false;
  active.clear();
  retries.clear();
  stopped = false;
}

export function __getActiveIdsForTests(): string[] {
  return [...active.keys()];
}
