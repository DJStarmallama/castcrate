/**
 * OpenSubtitles REST API v1 adapter.
 *
 * Used as a fallback subtitle source when a torrent has no embedded SRT/VTT
 * (e.g. YTS releases). When `config.openSubtitlesApiKey` is unset the adapter
 * is disabled — every function returns an empty/no-op result so callers
 * don't need to guard themselves.
 *
 * Docs: https://opensubtitles.stoplight.io/docs/opensubtitles-api
 *
 * Rate-limit / quota gotchas:
 *  - Free tier: 5 downloads/day (per API key, not per user). Search itself
 *    is more lenient but still rate-limited.
 *  - `Api-Key` and `User-Agent` are BOTH required by TOS — omitting either
 *    yields 403.
 *  - `POST /download` returns a temporary URL (5-minute lifetime). We stream
 *    it once and persist the SRT to disk so subsequent requests never hit
 *    the quota again.
 *  - 429 responses are surfaced as an LRU miss + rethrown — no built-in
 *    backoff. That's fine while the cache absorbs repeat requests.
 */
import { LRUCache } from "lru-cache";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../lib/config.js";

const OS_BASE = "https://api.opensubtitles.com/api/v1";
const USER_AGENT = "CastCrate/1.0";

/** Where downloaded SRT files live on disk. Created lazily on first fetch to
 *  avoid a boot-time mkdir on machines that never enable OpenSubtitles.
 *  Lives under the same downloadPath as torrents so cleanup can be done in
 *  one sweep — small files (few KB each), few per movie, kept forever. */
function cacheDir(): string {
  return join(config.downloadPath, ".opensubtitles");
}

export interface OpenSubtitleTrack {
  /** `os:<file_id>` — synthetic so callers can distinguish OS tracks from
   *  torrent-embedded ones without a source discriminator flag. */
  id: string;
  /** The bare OpenSubtitles file_id — used as the URL path segment on the
   *  content-serving route. */
  fileId: string;
  /** ISO 639-1 code returned by OpenSubtitles (`en`, `ja`, `pt-br`). */
  language: string;
  /** Display name, e.g. `"English"`. */
  languageName: string;
  /** OpenSubtitles' release string — useful for disambiguating multiple
   *  tracks in the same language. */
  releaseName?: string;
  /** Download count — used for sorting in the picker. Optional because some
   *  responses omit it. */
  downloadCount?: number;
}

// ------------------------------------------------------------
// Search
// ------------------------------------------------------------

interface SearchOpts {
  /** IMDb ID like "tt1375666". The `tt` prefix is stripped before sending
   *  (OpenSubtitles wants the numeric id). */
  imdbId?: string;
  /** Fallback when no imdbId is available. */
  query?: string;
  /** ISO 639-1 language codes to filter by. Defaults to
   *  `config.openSubtitlesLanguages` (env `OPENSUBTITLES_LANGUAGES`). */
  languages?: string[];
}

interface OsSubtitleAttributes {
  language?: string;
  release?: string;
  download_count?: number;
  files?: { file_id?: number; file_name?: string }[];
}

interface OsSubtitleData {
  id: string;
  type: string;
  attributes: OsSubtitleAttributes;
}

interface OsSearchResponse {
  total_pages?: number;
  total_count?: number;
  page?: number;
  data?: OsSubtitleData[];
}

/** Search-result LRU. Key derived from imdbId+query+languages (NOT the API
 *  key — we don't want it leaking into any log line that dumps cache keys). */
const searchCache = new LRUCache<string, OpenSubtitleTrack[]>({
  max: 200,
  ttl: 1000 * 60 * 60, // 1h
});

function isEnabled(): boolean {
  return Boolean(config.openSubtitlesApiKey);
}

function normalizeImdbId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Strip "tt" prefix and any leading zeros are actually meaningful, so keep
  // the numeric part verbatim.
  const m = /^tt(\d+)$/i.exec(raw.trim());
  return m ? m[1] : undefined;
}

const ISO_TO_NAME: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  "pt-br": "Portuguese (Brazil)",
  "pt-pt": "Portuguese (Portugal)",
  nl: "Dutch",
  ru: "Russian",
  ja: "Japanese",
  zh: "Chinese",
  "zh-cn": "Chinese (Simplified)",
  "zh-tw": "Chinese (Traditional)",
  ko: "Korean",
  ar: "Arabic",
  pl: "Polish",
  tr: "Turkish",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian",
  fi: "Finnish",
  el: "Greek",
  cs: "Czech",
  hu: "Hungarian",
  ro: "Romanian",
  he: "Hebrew",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  hi: "Hindi",
};

function languageName(iso: string): string {
  const key = iso.toLowerCase();
  return ISO_TO_NAME[key] ?? iso.toUpperCase();
}

function attributesToTrack(data: OsSubtitleData): OpenSubtitleTrack | null {
  const a = data.attributes;
  const file = a.files?.find((f) => typeof f.file_id === "number");
  if (!file?.file_id) return null;
  const lang = (a.language ?? "und").toLowerCase();
  const track: OpenSubtitleTrack = {
    id: `os:${file.file_id}`,
    fileId: String(file.file_id),
    language: lang,
    languageName: languageName(lang),
  };
  if (a.release) track.releaseName = a.release;
  if (typeof a.download_count === "number") {
    track.downloadCount = a.download_count;
  }
  return track;
}

/**
 * Search OpenSubtitles for a movie / episode. Returns tracks sorted by
 * download_count desc (most popular first) after filtering to the requested
 * languages. Cached for ~1h keyed on the imdbId+query+languages tuple.
 *
 * Returns [] when:
 *  - the adapter is disabled (no API key)
 *  - both imdbId and query are missing
 *  - the API errors (logged, not thrown — subtitle fallback is best-effort)
 *  - the response has no data / no SRT-containing entries
 */
export async function searchOpenSubtitles(
  opts: SearchOpts,
): Promise<OpenSubtitleTrack[]> {
  if (!isEnabled()) return [];

  const imdbNumeric = normalizeImdbId(opts.imdbId);
  const query = opts.query?.trim();
  if (!imdbNumeric && !query) return [];

  const languages =
    opts.languages && opts.languages.length > 0
      ? opts.languages.map((l) => l.toLowerCase())
      : config.openSubtitlesLanguages;

  const cacheKey = JSON.stringify({
    imdb: imdbNumeric ?? null,
    q: query ?? null,
    langs: [...languages].sort(),
  });
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const url = new URL(`${OS_BASE}/subtitles`);
  if (imdbNumeric) url.searchParams.set("imdb_id", imdbNumeric);
  if (query) url.searchParams.set("query", query);
  if (languages.length > 0) {
    // OpenSubtitles accepts a comma-separated list here.
    url.searchParams.set("languages", languages.join(","));
  }
  // Prefer SRT — the picker doesn't care about ext but we serve VTT-converted
  // SRT so filtering here reduces one server-side conversion path.
  url.searchParams.set("order_by", "download_count");
  url.searchParams.set("order_direction", "desc");

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Api-Key": config.openSubtitlesApiKey,
        "User-Agent": USER_AGENT,
      },
    });
  } catch (err) {
    console.log(
      `opensubtitles: search network error (${(err as Error).message})`,
    );
    return [];
  }
  if (!res.ok) {
    console.log(
      `opensubtitles: search HTTP ${res.status} for imdb=${imdbNumeric ?? "-"} q=${query ?? "-"}`,
    );
    return [];
  }
  let json: OsSearchResponse;
  try {
    json = (await res.json()) as OsSearchResponse;
  } catch (err) {
    console.log(
      `opensubtitles: search JSON parse error (${(err as Error).message})`,
    );
    return [];
  }

  const tracks: OpenSubtitleTrack[] = [];
  for (const entry of json.data ?? []) {
    const t = attributesToTrack(entry);
    if (!t) continue;
    // Filter to requested languages here in case the API returned extras.
    if (languages.length > 0 && !languages.includes(t.language)) continue;
    tracks.push(t);
  }
  // Sort by download count desc, treating missing as 0 — API already returns
  // in that order but we defensively re-sort in case of client-side filtering.
  tracks.sort((a, b) => (b.downloadCount ?? 0) - (a.downloadCount ?? 0));

  searchCache.set(cacheKey, tracks);
  return tracks;
}

// ------------------------------------------------------------
// Download
// ------------------------------------------------------------

interface OsDownloadResponse {
  link?: string;
  file_name?: string;
  requests?: number;
  remaining?: number;
  message?: string;
  reset_time?: string;
  reset_time_utc?: string;
}

/** Result of `fetchOpenSubtitle`: on-disk path to the cached SRT plus the
 *  content-type we should serve it as. Always SRT today — kept as a field
 *  so a future .vtt-native download path can slot in without a signature
 *  change. */
export interface OpenSubtitleFetchResult {
  srtPath: string;
  contentType: "text/srt" | "text/vtt";
}

/**
 * Fetch the SRT body for a given track id (either `os:<file_id>` or the bare
 * numeric file id) and cache it under `<downloadPath>/.opensubtitles/<file_id>.srt`.
 * Idempotent — a second call returns the cached copy without hitting the API,
 * which matters because OS enforces a 5-download/day quota on the free tier.
 *
 * Throws when the adapter is disabled or the API is unreachable. Callers at
 * the route boundary map this to 502 / 503 as appropriate.
 */
export async function fetchOpenSubtitle(
  id: string,
): Promise<OpenSubtitleFetchResult> {
  if (!isEnabled()) {
    throw new Error("OpenSubtitles is not configured (missing OPENSUBTITLES_API_KEY)");
  }
  const fileId = id.startsWith("os:") ? id.slice(3) : id;
  if (!/^\d+$/.test(fileId)) {
    throw new Error(`invalid OpenSubtitles file id: ${id}`);
  }

  const dir = cacheDir();
  const srtPath = join(dir, `${fileId}.srt`);
  if (existsSync(srtPath)) {
    return { srtPath, contentType: "text/srt" };
  }

  // Ask OS for a temporary download URL.
  let dlRes: Response;
  try {
    dlRes = await fetch(`${OS_BASE}/download`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Api-Key": config.openSubtitlesApiKey,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ file_id: Number(fileId) }),
    });
  } catch (err) {
    throw new Error(
      `opensubtitles: /download network error: ${(err as Error).message}`,
    );
  }
  if (!dlRes.ok) {
    // 406 = quota exceeded, 429 = rate limit — surface both as a plain error
    // for the route to map to 502.
    throw new Error(
      `opensubtitles: /download HTTP ${dlRes.status}${dlRes.status === 406 ? " (daily quota exceeded)" : ""}`,
    );
  }
  const meta = (await dlRes.json()) as OsDownloadResponse;
  if (!meta.link) {
    throw new Error(`opensubtitles: /download returned no link (${meta.message ?? "no message"})`);
  }

  // GET the actual SRT.
  let bodyRes: Response;
  try {
    bodyRes = await fetch(meta.link, {
      headers: { "User-Agent": USER_AGENT },
    });
  } catch (err) {
    throw new Error(
      `opensubtitles: download URL fetch failed: ${(err as Error).message}`,
    );
  }
  if (!bodyRes.ok) {
    throw new Error(`opensubtitles: download URL HTTP ${bodyRes.status}`);
  }
  const srt = await bodyRes.text();

  await mkdir(dir, { recursive: true });
  await writeFile(srtPath, srt, "utf8");

  return { srtPath, contentType: "text/srt" };
}

/** Read the cached SRT body for a track id. Convenience wrapper — the route
 *  handler needs a string to convert-and-serve, and this hides the fs call. */
export async function readOpenSubtitleContents(id: string): Promise<string> {
  const { srtPath } = await fetchOpenSubtitle(id);
  return readFile(srtPath, "utf8");
}

// Exported for tests only.
export const _internals = {
  languageName,
  normalizeImdbId,
  cacheDir,
  searchCache,
};
