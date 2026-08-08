import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Sandboxed systemd units block writes to $HOME by default; operators can
// point this at a ReadWritePaths-approved location (e.g. StateDirectory=
// gives /var/lib/castcrate for free) without patching the source.
const HISTORY_DIR = process.env.HISTORY_DIR
  ? resolve(process.env.HISTORY_DIR)
  : join(homedir(), ".castcrate");
const HISTORY_PATH = join(HISTORY_DIR, "history.json");
const TMP_PATH = `${HISTORY_PATH}.tmp`;

export interface HistoryEntry {
  id: string;
  title: string;
  posterUrl: string | null;
  imdbId: string | null;
  resolution: string | null;
  videoName: string;
  startedAt: string;
  endedAt: string;
  completed: boolean;
}

let cache: HistoryEntry[] | null = null;

async function ensureDir(): Promise<void> {
  if (!existsSync(HISTORY_DIR)) {
    await mkdir(HISTORY_DIR, { recursive: true });
  }
}

async function load(): Promise<HistoryEntry[]> {
  if (cache) return cache;
  await ensureDir();
  try {
    const raw = await readFile(HISTORY_PATH, "utf8");
    cache = JSON.parse(raw) as HistoryEntry[];
  } catch {
    cache = [];
  }
  return cache;
}

// Atomic write: stage to a sibling .tmp file, then rename. POSIX rename is
// atomic, so a crash during writeFile leaves the original intact.
async function save(): Promise<void> {
  if (!cache) return;
  await ensureDir();
  await writeFile(TMP_PATH, JSON.stringify(cache, null, 2), "utf8");
  await rename(TMP_PATH, HISTORY_PATH);
}

export async function listHistory(): Promise<HistoryEntry[]> {
  return load();
}

export async function appendHistory(entry: HistoryEntry): Promise<void> {
  const entries = await load();
  entries.unshift(entry);
  // cap at 200
  if (entries.length > 200) entries.length = 200;
  cache = entries;
  await save();
}

export async function updateHistoryById(
  id: string,
  partial: Partial<Omit<HistoryEntry, "id">>,
): Promise<boolean> {
  const entries = await load();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  entries[idx] = { ...entries[idx]!, ...partial };
  cache = entries;
  await save();
  return true;
}

export async function clearHistory(): Promise<void> {
  cache = [];
  await save();
}
