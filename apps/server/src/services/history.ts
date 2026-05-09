import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HISTORY_DIR = join(homedir(), ".castcrate");
const HISTORY_PATH = join(HISTORY_DIR, "history.json");

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

async function ensureFile(): Promise<void> {
  if (!existsSync(HISTORY_DIR)) {
    await mkdir(HISTORY_DIR, { recursive: true });
  }
  if (!existsSync(HISTORY_PATH)) {
    await writeFile(HISTORY_PATH, "[]", "utf8");
  }
}

async function load(): Promise<HistoryEntry[]> {
  if (cache) return cache;
  await ensureFile();
  try {
    const raw = await readFile(HISTORY_PATH, "utf8");
    cache = JSON.parse(raw) as HistoryEntry[];
  } catch {
    cache = [];
  }
  return cache;
}

async function save(): Promise<void> {
  if (!cache) return;
  await ensureFile();
  await writeFile(HISTORY_PATH, JSON.stringify(cache, null, 2), "utf8");
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

export async function clearHistory(): Promise<void> {
  cache = [];
  await save();
}
