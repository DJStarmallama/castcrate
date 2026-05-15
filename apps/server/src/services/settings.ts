import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../lib/config.js";

const DIR = join(homedir(), ".castcrate");
const PATH = join(DIR, "settings.json");
const TMP_PATH = `${PATH}.tmp`;

export interface ProxyEnabled {
  yts: boolean;
  eztv: boolean;
  knaben: boolean;
  torrentday: boolean;
}

export interface TorrentDaySettings {
  enabled: boolean;
  uid: string | null;
  pass: string | null;
}

export interface RuntimeSettings {
  bufferPercent: number;
  transcodeBufferPercent: number;
  transcodeBitrate: string;
  /** SOCKS5 / HTTP proxy URL used for per-provider outbound requests.
   *  null means no proxy configured. */
  proxyUrl: string | null;
  /** Per-provider opt-in. Defaults: all false. */
  proxyEnabled: ProxyEnabled;
  /** TorrentDay private tracker credentials + toggle. */
  torrentDay: TorrentDaySettings;
}

const ALLOWED_KEYS: ReadonlyArray<keyof RuntimeSettings> = [
  "bufferPercent",
  "transcodeBufferPercent",
  "transcodeBitrate",
  "proxyUrl",
  "proxyEnabled",
  "torrentDay",
];

const PROXY_URL_RE = /^(socks5h?|http|https):\/\/.+/;

const PROXY_ENABLED_DEFAULTS: ProxyEnabled = {
  yts: false,
  eztv: false,
  knaben: false,
  torrentday: false,
};

const TORRENT_DAY_DEFAULTS: TorrentDaySettings = {
  enabled: false,
  uid: null,
  pass: null,
};

let overrides: Partial<RuntimeSettings> = {};

/** Callback list invoked after settings are persisted — used by proxy cache invalidation. */
const onUpdateCallbacks: Array<() => void> = [];

export function onSettingsUpdate(cb: () => void): void {
  onUpdateCallbacks.push(cb);
}

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
    proxyUrl: overrides.proxyUrl !== undefined ? overrides.proxyUrl : (config.proxyUrl ?? null),
    proxyEnabled: overrides.proxyEnabled
      ? { ...PROXY_ENABLED_DEFAULTS, ...overrides.proxyEnabled }
      : { ...PROXY_ENABLED_DEFAULTS },
    torrentDay: overrides.torrentDay
      ? { ...TORRENT_DAY_DEFAULTS, ...overrides.torrentDay }
      : { ...TORRENT_DAY_DEFAULTS },
  };
}

export async function updateSettings(
  partial: Partial<RuntimeSettings>,
): Promise<RuntimeSettings> {
  const sanitised = sanitise(partial);
  const next: Partial<RuntimeSettings> = { ...overrides };

  // Simple scalar fields: null/undefined explicitly resets to env default.
  for (const k of ALLOWED_KEYS) {
    if (k === "proxyUrl") {
      if ("proxyUrl" in partial) {
        // explicit null clears; valid string sets; invalid string was already
        // dropped by sanitise(), so leave unchanged if not in sanitised.
        if (partial.proxyUrl === null) {
          next.proxyUrl = null;
        } else if (sanitised.proxyUrl !== undefined) {
          next.proxyUrl = sanitised.proxyUrl;
        }
      }
    } else if (k === "proxyEnabled") {
      if (partial.proxyEnabled !== undefined && sanitised.proxyEnabled !== undefined) {
        // Partial merge — only update the keys present in the patch.
        next.proxyEnabled = {
          ...PROXY_ENABLED_DEFAULTS,
          ...overrides.proxyEnabled,
          ...sanitised.proxyEnabled,
        };
      }
    } else if (k === "torrentDay") {
      if ("torrentDay" in partial) {
        if (partial.torrentDay === null) {
          // Explicit null resets to defaults — remove from overrides.
          delete next.torrentDay;
        } else if (sanitised.torrentDay !== undefined) {
          // Partial merge inside the block.
          next.torrentDay = {
            ...TORRENT_DAY_DEFAULTS,
            ...overrides.torrentDay,
            ...sanitised.torrentDay,
          };
        }
      }
    } else {
      // Regular scalar keys
      const key = k as Exclude<keyof RuntimeSettings, "proxyUrl" | "proxyEnabled" | "torrentDay">;
      if (partial[key] === null || partial[key] === undefined) {
        delete next[key];
      } else if (sanitised[key] !== undefined) {
        (next as Record<string, unknown>)[key] = sanitised[key];
      }
    }
  }

  overrides = next;
  await persist();

  // Notify listeners (e.g. proxy dispatcher cache invalidation).
  for (const cb of onUpdateCallbacks) cb();

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

  // proxyUrl: null clears; string must match the scheme regex.
  if ("proxyUrl" in input) {
    if (input.proxyUrl === null) {
      out.proxyUrl = null;
    } else if (typeof input.proxyUrl === "string" && PROXY_URL_RE.test(input.proxyUrl)) {
      out.proxyUrl = input.proxyUrl;
    }
    // invalid string → silently dropped (caller checked via ALLOWED_KEYS loop)
  }

  // proxyEnabled: accept partial objects — coerce each recognised key to boolean.
  if (input.proxyEnabled !== null && typeof input.proxyEnabled === "object") {
    const pe = input.proxyEnabled as unknown as Record<string, unknown>;
    const sanitisedPe: Partial<ProxyEnabled> = {};
    for (const key of Object.keys(PROXY_ENABLED_DEFAULTS) as Array<keyof ProxyEnabled>) {
      if (key in pe) sanitisedPe[key] = Boolean(pe[key]);
    }
    if (Object.keys(sanitisedPe).length > 0) {
      out.proxyEnabled = sanitisedPe as ProxyEnabled;
    }
  }

  // torrentDay: partial object — validate each field individually.
  if (input.torrentDay !== null && typeof input.torrentDay === "object") {
    const td = input.torrentDay as unknown as Record<string, unknown>;
    const sanitisedTd: Partial<TorrentDaySettings> = {};
    if ("enabled" in td) {
      sanitisedTd.enabled = Boolean(td.enabled);
    }
    if ("uid" in td) {
      if (td.uid === null || td.uid === "" || td.uid === undefined) {
        sanitisedTd.uid = null;
      } else if (typeof td.uid === "string" && /^\d+$/.test(td.uid.trim())) {
        sanitisedTd.uid = td.uid.trim();
      }
      // invalid uid → silently dropped
    }
    if ("pass" in td) {
      if (td.pass === null || td.pass === "" || td.pass === undefined) {
        sanitisedTd.pass = null;
      } else if (typeof td.pass === "string" && /^[A-Za-z0-9]+$/.test(td.pass.trim())) {
        sanitisedTd.pass = td.pass.trim();
      }
      // invalid pass → silently dropped
    }
    if (Object.keys(sanitisedTd).length > 0) {
      // Only store the validated keys — the update loop handles merging with
      // defaults and existing overrides so we don't stomp un-specified fields.
      out.torrentDay = sanitisedTd as TorrentDaySettings;
    }
  }

  return out;
}

export { PROXY_URL_RE };
