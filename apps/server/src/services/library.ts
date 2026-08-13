import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AddToQueueRequest,
  AddToQueueResponse,
  LibraryItem,
  LibraryListResponse,
} from "@castcrate/shared";

// Reuse the same directory as history.ts — one dir holds all CastCrate JSON
// state (hardening B1 precedent). Sandboxed systemd units block writes to
// $HOME by default; operators can point HISTORY_DIR at a ReadWritePaths=
// approved location (e.g. StateDirectory=castcrate → /var/lib/castcrate).
const LIBRARY_DIR = process.env.HISTORY_DIR
  ? resolve(process.env.HISTORY_DIR)
  : join(homedir(), ".castcrate");
const LIBRARY_PATH = join(LIBRARY_DIR, "library.json");
const TMP_PATH = `${LIBRARY_PATH}.tmp`;

let cache: LibraryItem[] | null = null;

// Module-level mutex. Every mutation acquires this lock, performs its
// load/modify/save sequence, and releases. This prevents two concurrent
// callers from both reading a stale snapshot, mutating in parallel, and
// then having the second save() overwrite the first (lost-write race).
// Reads that don't mutate (listLibrary, findByX) don't acquire the lock —
// they can safely serve from the cache while a write is in flight; the
// worst case is they see the pre-write snapshot.
let writeLock: Promise<void> = Promise.resolve();

/** Acquire the write lock, run `body`, release. Ensures the load/modify/save
 *  cycle is atomic against other mutations. */
async function withLock<T>(body: () => Promise<T>): Promise<T> {
  const previous = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((r) => {
    release = r;
  });
  try {
    await previous;
    return await body();
  } finally {
    release();
  }
}

async function ensureDir(): Promise<void> {
  if (!existsSync(LIBRARY_DIR)) {
    await mkdir(LIBRARY_DIR, { recursive: true });
  }
}

/**
 * Hydrate the in-memory cache from disk on first call; return cached copy
 * afterwards. On parse errors we log a warning (history.ts's silent fallback
 * has bitten us — hardening called it out) and degrade to `[]` so subsequent
 * writes still succeed. Missing file is normal (fresh install) — no warning.
 */
export async function load(): Promise<LibraryItem[]> {
  if (cache) return cache;
  await ensureDir();
  try {
    const raw = await readFile(LIBRARY_PATH, "utf8");
    try {
      cache = JSON.parse(raw) as LibraryItem[];
      if (!Array.isArray(cache)) {
        console.warn(
          `[library] ${LIBRARY_PATH} did not parse to an array (got ${typeof cache}); falling back to empty list`,
        );
        cache = [];
      }
    } catch (err) {
      console.warn(
        `[library] ${LIBRARY_PATH} is corrupt (${err instanceof Error ? err.message : String(err)}); falling back to empty list. The file will be overwritten on the next mutation.`,
      );
      cache = [];
    }
  } catch {
    // ENOENT — normal on a fresh install. No log.
    cache = [];
  }
  return cache;
}

/**
 * Atomic write: stage to a sibling .tmp file, then rename. POSIX rename is
 * atomic, so a crash during writeFile leaves the original intact. Callers
 * MUST hold the writeLock — see withLock().
 */
async function save(): Promise<void> {
  if (!cache) return;
  await ensureDir();
  await writeFile(TMP_PATH, JSON.stringify(cache, null, 2), "utf8");
  await rename(TMP_PATH, LIBRARY_PATH);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Extract the infoHash from a magnet URI's `xt=urn:btih:<HEX>` param.
 *  Returns lowercase hash (webtorrent normalizes to lowercase; matches the
 *  case-fix in torrent.ts). Returns null when the magnet is malformed or
 *  uses a non-btih xt scheme. */
function extractHashFromMagnet(magnet: string): string | null {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/);
  if (!m || !m[1]) return null;
  return m[1].toLowerCase();
}

function sortByAddedAtDesc(a: LibraryItem, b: LibraryItem): number {
  // ISO 8601 sorts lexicographically. Descending: b first.
  return b.addedAt.localeCompare(a.addedAt);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listLibrary(): Promise<LibraryListResponse> {
  const items = await load();
  const sorted = [...items].sort(sortByAddedAtDesc);
  const queued: LibraryItem[] = [];
  const downloading: LibraryItem[] = [];
  const completed: LibraryItem[] = [];
  for (const item of sorted) {
    if (item.completedAt !== null) completed.push(item);
    else if (item.hash !== null) downloading.push(item);
    else queued.push(item);
  }
  return { queued, downloading, completed };
}

export async function findById(id: string): Promise<LibraryItem | null> {
  const items = await load();
  return items.find((i) => i.id === id) ?? null;
}

export async function findByHash(hash: string): Promise<LibraryItem | null> {
  const items = await load();
  const lc = hash.toLowerCase();
  return items.find((i) => i.hash !== null && i.hash.toLowerCase() === lc) ?? null;
}

export async function findByMagnet(magnet: string): Promise<LibraryItem | null> {
  const items = await load();
  return items.find((i) => i.magnet === magnet) ?? null;
}

/**
 * Idempotent add. Dedupe key: (1) hash if extractable from the magnet AND an
 * existing entry has a matching hash; (2) exact magnet string. On dedupe hit
 * we return the existing id without mutating the manifest.
 *
 * The whole read/dedupe/append/save cycle runs under the writeLock so two
 * concurrent adds don't clobber each other's write.
 */
export async function addToQueue(
  req: AddToQueueRequest,
): Promise<AddToQueueResponse> {
  return withLock(async () => {
    const items = await load();
    const hash = extractHashFromMagnet(req.magnet);

    // Check dedupe FIRST — before mutating. If either the hash or the exact
    // magnet matches, treat as already present.
    if (hash) {
      const existingByHash = items.find(
        (i) => i.hash !== null && i.hash.toLowerCase() === hash,
      );
      if (existingByHash) {
        return { id: existingByHash.id, alreadyPresent: true };
      }
    }
    const existingByMagnet = items.find((i) => i.magnet === req.magnet);
    if (existingByMagnet) {
      return { id: existingByMagnet.id, alreadyPresent: true };
    }

    const id = randomUUID();
    const item: LibraryItem = {
      id,
      magnet: req.magnet,
      hash,
      title: req.metadata.title,
      year: req.metadata.year,
      poster: req.metadata.poster,
      imdbId: req.metadata.imdbId,
      source: req.metadata.source,
      addedAt: new Date().toISOString(),
      completedAt: null,
      filePath: null,
      pinned: false,
    };
    items.push(item);
    cache = items;
    await save();
    return { id, alreadyPresent: false };
  });
}

/** Called by the download-queue worker once torrent.infoHash is known
 *  post-metadata. Leaves completedAt null — the "downloading" bucket keys on
 *  `hash !== null && completedAt === null`. */
export async function markDownloading(
  id: string,
  hash: string,
): Promise<void> {
  await withLock(async () => {
    const items = await load();
    const item = items.find((i) => i.id === id);
    if (!item) return;
    item.hash = hash.toLowerCase();
    cache = items;
    await save();
  });
}

/** Called on torrent 'done'. Sets completedAt + absolute filePath. */
export async function markCompleted(
  id: string,
  filePath: string,
): Promise<void> {
  await withLock(async () => {
    const items = await load();
    const item = items.find((i) => i.id === id);
    if (!item) return;
    item.completedAt = new Date().toISOString();
    item.filePath = filePath;
    cache = items;
    await save();
  });
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  await withLock(async () => {
    const items = await load();
    const item = items.find((i) => i.id === id);
    if (!item) return;
    item.pinned = pinned;
    cache = items;
    await save();
  });
}

/**
 * Remove a manifest entry by id. Returns the removed item (or null if not
 * found) so the route layer can decide what on-disk cleanup to do — this
 * service NEVER touches files (single-responsibility: manifest only).
 */
export async function remove(id: string): Promise<{ item: LibraryItem | null }> {
  return withLock(async () => {
    const items = await load();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return { item: null };
    const [removed] = items.splice(idx, 1);
    cache = items;
    await save();
    return { item: removed ?? null };
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Drops the in-memory cache. Vitest calls this between suites so the next
 *  load() re-reads from the (mocked or freshly-cleaned) disk state. Not used
 *  outside tests. */
export function __resetLibraryCacheForTests(): void {
  cache = null;
  writeLock = Promise.resolve();
}
