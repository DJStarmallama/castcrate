import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../lib/config.js";

const DIR = join(homedir(), ".castcrate");
const PATH = join(DIR, "settings.json");
const TMP_PATH = `${PATH}.tmp`;

export interface RuntimeSettings {
  bufferPercent: number;
  transcodeBufferPercent: number;
  transcodeBitrate: string;
}

const ALLOWED_KEYS: ReadonlyArray<keyof RuntimeSettings> = [
  "bufferPercent",
  "transcodeBufferPercent",
  "transcodeBitrate",
];

let overrides: Partial<RuntimeSettings> = {};

async function ensureDir(): Promise<void> {
  if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });
}

/**
 * Initialise the runtime settings cache from `~/.castcrate/settings.json`.
 * Must be called once during boot. Subsequent reads are sync via `getSettings()`.
 */
export async function initSettings(): Promise<void> {
  if (!existsSync(PATH)) {
    overrides = {};
    return;
  }
  try {
    const raw = await readFile(PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeSettings>;
    overrides = sanitise(parsed);
  } catch {
    overrides = {};
  }
}

/** Atomic write — temp file + rename. */
async function persist(): Promise<void> {
  await ensureDir();
  await writeFile(TMP_PATH, JSON.stringify(overrides, null, 2), "utf8");
  await rename(TMP_PATH, PATH);
}

/**
 * Layered: env-default from `lib/config.ts` overlaid by the runtime overrides
 * loaded from `~/.castcrate/settings.json`.
 */
export function getSettings(): RuntimeSettings {
  return {
    bufferPercent: overrides.bufferPercent ?? config.bufferPercent,
    transcodeBufferPercent:
      overrides.transcodeBufferPercent ?? config.transcodeBufferPercent,
    transcodeBitrate: overrides.transcodeBitrate ?? config.transcodeBitrate,
  };
}

export async function updateSettings(
  partial: Partial<RuntimeSettings>,
): Promise<RuntimeSettings> {
  const next = { ...overrides, ...sanitise(partial) };
  // null/undefined explicitly resets to env default
  for (const k of ALLOWED_KEYS) {
    if (partial[k] === null || partial[k] === undefined) {
      delete next[k];
    }
  }
  overrides = next;
  await persist();
  return getSettings();
}

/** Drop unknown keys and reject obviously bad values. */
function sanitise(input: Partial<RuntimeSettings>): Partial<RuntimeSettings> {
  const out: Partial<RuntimeSettings> = {};
  if (input.bufferPercent !== undefined && input.bufferPercent !== null) {
    const n = Number(input.bufferPercent);
    if (Number.isFinite(n) && n >= 0 && n <= 100) out.bufferPercent = n;
  }
  if (
    input.transcodeBufferPercent !== undefined &&
    input.transcodeBufferPercent !== null
  ) {
    const n = Number(input.transcodeBufferPercent);
    if (Number.isFinite(n) && n >= 0 && n <= 100) {
      out.transcodeBufferPercent = n;
    }
  }
  if (
    input.transcodeBitrate !== undefined &&
    input.transcodeBitrate !== null
  ) {
    const s = String(input.transcodeBitrate);
    // accept 5M, 4500k, 1500000 — same forms transcoder.ts already understands
    if (/^\d+(?:\.\d+)?[kKmM]?$/.test(s)) out.transcodeBitrate = s;
  }
  return out;
}
