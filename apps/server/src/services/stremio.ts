import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { TorrentResult } from "@castcrate/shared";
import type { Dispatcher, RequestInit as UndiciRequestInit } from "undici";
import {
  formatBytes,
  isCastFriendly,
  parseQuality,
  rankTorrent,
} from "../lib/quality.js";
import { getDispatcher } from "../lib/proxy.js";
import { getSettings } from "./settings.js";

// ---------------------------------------------------------------------------
// Fallback tracker list — mirrors what knaben.ts uses in buildMagnet().
// ---------------------------------------------------------------------------
const FALLBACK_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:80/announce",
  "udp://exodus.desync.com:6969/announce",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StremioManifest {
  id: string;
  name: string;
  version: string;
  resources: string[];
  types: string[];
  idPrefixes?: string[];
  behaviorHints?: { configurationRequired?: boolean; [k: string]: unknown };
}

export interface StremioStreamResult extends TorrentResult {
  source: "stremio";
  addonOrigin: string;
  streamUrl?: string;
  magnet: string; // empty string when streamUrl is set
  fileIdx?: number;
}

interface RawStream {
  name?: string;
  title?: string;
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  url?: string;
  behaviorHints?: {
    videoSize?: number;
    [key: string]: unknown;
  };
}

interface StremioStreamsResponse {
  streams?: RawStream[];
}

// ---------------------------------------------------------------------------
// LRU cache — short TTL because debrid URLs are time-limited.
// ---------------------------------------------------------------------------
const cache = new LRUCache<string, StremioStreamResult[]>({
  max: 200,
  ttl: 10 * 60 * 1000, // 10 min
});

/** Clears the search result cache — for use in tests only. */
export function _clearCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

/**
 * Strips trailing `/manifest.json` (case-insensitive) and trailing `/`
 * so callers can paste either the manifest URL or the base URL.
 */
export function normaliseAddonBase(url: string): string {
  let result = url.trim();
  // Strip trailing /manifest.json (case-insensitive)
  result = result.replace(/\/manifest\.json$/i, "");
  // Strip a single trailing /
  result = result.replace(/\/$/, "");
  return result;
}

// ---------------------------------------------------------------------------
// Addon hash — cache key component that invalidates when the addon list changes.
// ---------------------------------------------------------------------------

function addonsHash(addons: Array<{ id: string; enabled: boolean }>): string {
  const tuples = addons.map((a) => [a.id, a.enabled]);
  return createHash("sha1").update(JSON.stringify(tuples)).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// validateAddon
// ---------------------------------------------------------------------------

/**
 * Probes the addon's `/manifest.json` to confirm it speaks the Stremio protocol
 * and exposes the `"stream"` resource.
 */
export async function validateAddon(url: string): Promise<{
  ok: boolean;
  manifest?: StremioManifest;
  error?: string;
  warning?: string;
}> {
  const base = normaliseAddonBase(url);
  const manifestUrl = `${base}/manifest.json`;

  const dispatcher = getDispatcher("stremio") as Dispatcher | undefined;

  let res: Response;
  try {
    res = await fetch(manifestUrl, {
      signal: AbortSignal.timeout(8000),
      dispatcher,
    } as UndiciRequestInit as unknown as RequestInit);
  } catch (err) {
    const msg = (err as Error).message ?? "network error";
    return { ok: false, error: `Failed to reach addon: ${msg}` };
  }

  if (!res.ok) {
    return { ok: false, error: `Addon returned HTTP ${res.status}` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "Addon returned invalid JSON" };
  }

  if (json === null || typeof json !== "object") {
    return { ok: false, error: "Addon manifest is not a JSON object" };
  }

  const manifest = json as Record<string, unknown>;

  // Validate required fields
  if (
    typeof manifest.id !== "string" ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string" ||
    !Array.isArray(manifest.resources)
  ) {
    return { ok: false, error: "Addon manifest is missing required fields (id, name, version, resources)" };
  }

  // Resources can be either an array of strings ["stream", "catalog"] OR an
  // array of objects [{ name: "stream", types: [...], idPrefixes: [...] }].
  // The object form lets addons declare per-resource type/id-prefix filters.
  // Torrentio uses the object form — we accept both.
  const resources = manifest.resources as unknown[];
  const streamResource = resources.find((r) => {
    if (typeof r === "string") return r === "stream";
    if (r !== null && typeof r === "object" && "name" in r) {
      return (r as { name: unknown }).name === "stream";
    }
    return false;
  });
  if (!streamResource) {
    return { ok: false, error: "addon doesn't expose stream resource" };
  }

  // Build optional warning strings for non-fatal advisory conditions.
  const warningParts: string[] = [];

  // idPrefixes can live at the manifest top level OR inside the stream
  // resource object. Check both; an addon that doesn't support "tt" lookups
  // anywhere should warn the user.
  const topLevelPrefixes = Array.isArray(manifest.idPrefixes)
    ? (manifest.idPrefixes as unknown[])
    : null;
  const resourcePrefixes =
    typeof streamResource === "object" &&
    streamResource !== null &&
    "idPrefixes" in streamResource &&
    Array.isArray((streamResource as { idPrefixes: unknown }).idPrefixes)
      ? ((streamResource as { idPrefixes: unknown[] }).idPrefixes)
      : null;
  const effectivePrefixes = resourcePrefixes ?? topLevelPrefixes;
  if (effectivePrefixes !== null && !effectivePrefixes.includes("tt")) {
    warningParts.push("addon may not support IMDb-keyed (tt…) lookups");
  }

  // If the addon signals it needs configuration, alert the user to get a personal URL.
  const behaviorHints = manifest.behaviorHints as { configurationRequired?: boolean } | undefined;
  if (behaviorHints?.configurationRequired === true) {
    warningParts.push(
      "addon requires configuration — visit the addon’s setup page to get a personalised URL",
    );
  }

  const warning = warningParts.length > 0 ? warningParts.join(" / ") : undefined;

  const parsedManifest: StremioManifest = {
    id: manifest.id as string,
    name: manifest.name as string,
    version: manifest.version as string,
    resources: resources as string[],
    types: Array.isArray(manifest.types) ? (manifest.types as string[]) : [],
    ...(Array.isArray(manifest.idPrefixes) ? { idPrefixes: manifest.idPrefixes as string[] } : {}),
    ...(manifest.behaviorHints !== undefined ? { behaviorHints: manifest.behaviorHints as StremioManifest["behaviorHints"] } : {}),
  };

  return { ok: true, manifest: parsedManifest, ...(warning !== undefined ? { warning } : {}) };
}

// ---------------------------------------------------------------------------
// Per-stream parsing
// ---------------------------------------------------------------------------

function buildMagnetFromStream(infoHash: string, title: string, sources?: string[]): string {
  // Extract tracker URLs from sources[] that start with "tracker:".
  // Only keep entries whose URL, after stripping the "tracker:" prefix,
  // starts with a well-known scheme. Malformed entries are dropped silently.
  const VALID_TRACKER_SCHEMES = ["udp://", "http://", "https://"];
  const trackers: string[] = [];
  if (sources && sources.length > 0) {
    for (const s of sources) {
      if (s.startsWith("tracker:")) {
        const trackerUrl = s.slice("tracker:".length);
        if (VALID_TRACKER_SCHEMES.some((scheme) => trackerUrl.startsWith(scheme))) {
          trackers.push(trackerUrl);
        }
      }
    }
  }
  // Fall back to hardcoded list if none passed scheme validation
  const trackerList = trackers.length > 0 ? trackers : FALLBACK_TRACKERS;
  const trParams = trackerList.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}${trParams}`;
}

function toResult(stream: RawStream, addonOrigin: string): StremioStreamResult | null {
  const title = stream.title ?? stream.name ?? "";
  const quality = parseQuality(title);

  // Drop xvid like other adapters
  if (quality.videoCodec === "xvid") return null;

  const sizeBytes = stream.behaviorHints?.videoSize ?? 0;
  const size = sizeBytes > 0 ? formatBytes(sizeBytes) : "";

  const base: Omit<StremioStreamResult, "streamUrl" | "magnet" | "fileIdx"> = {
    title,
    size,
    sizeBytes,
    seeds: 0,
    peers: 0,
    resolution: quality.resolution,
    videoCodec: quality.videoCodec,
    source: "stremio",
    castFriendly: isCastFriendly(quality),
    addonOrigin,
  };

  if (stream.url) {
    // Torrentio (and similar debrid-aware addons) returns a placeholder video
    // — `https://torrentio.strem.fun/videos/downloading_v2.mp4` — when the
    // torrent ISN'T actually cached on Real-Debrid yet. The addon kicks off
    // a background RD download and returns this 1MB stub in the meantime.
    // These results would mislead the user with an "⚡ Instant" badge that
    // plays a 5-second "downloading…" clip. Drop them at parse time.
    if (/\/videos\/downloading[^/]*\.(mp4|mkv|webm)$/i.test(stream.url)) {
      return null;
    }
    // HTTP stream shape — bypass webtorrent
    return {
      ...base,
      streamUrl: stream.url,
      magnet: "",
    };
  }

  if (stream.infoHash) {
    // Magnet stream shape — reconstruct magnet
    const magnet = buildMagnetFromStream(stream.infoHash, title, stream.sources);
    const result: StremioStreamResult = {
      ...base,
      magnet,
    };
    if (typeof stream.fileIdx === "number") {
      result.fileIdx = stream.fileIdx;
    }
    return result;
  }

  // Neither url nor infoHash — drop
  return null;
}

// ---------------------------------------------------------------------------
// Internal: call one addon and return parsed results
// ---------------------------------------------------------------------------

async function callOneAddon(
  addonUrl: string,
  addonName: string,
  path: string,
  dispatcher: Dispatcher | undefined,
): Promise<StremioStreamResult[]> {
  const base = normaliseAddonBase(addonUrl);
  const url = `${base}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      dispatcher,
    } as UndiciRequestInit as unknown as RequestInit);
  } catch (err) {
    const msg = (err as Error).message ?? "unknown error";
    console.log(`stremio: addon "${addonName}" failed — ${msg}`);
    throw err;
  }

  if (!res.ok) {
    console.log(`stremio: addon "${addonName}" failed — HTTP ${res.status}`);
    throw new Error(`HTTP ${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    console.log(`stremio: addon "${addonName}" failed — invalid JSON`);
    throw new Error("invalid JSON");
  }

  const body = json as StremioStreamsResponse;
  const streams = body.streams ?? [];
  const results: StremioStreamResult[] = [];

  for (const stream of streams) {
    const r = toResult(stream, addonName);
    if (r) results.push(r);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

function dedupeResults(results: StremioStreamResult[]): StremioStreamResult[] {
  const seenInfoHash = new Set<string>();
  const seenStreamUrl = new Set<string>();
  const deduped: StremioStreamResult[] = [];

  for (const r of results) {
    // Extract infoHash from the magnet if set
    const infoHashMatch = /[?&]xt=urn:btih:([a-fA-F0-9]+)/i.exec(r.magnet);
    const infoHash = infoHashMatch ? infoHashMatch[1]!.toLowerCase() : null;

    if (infoHash) {
      if (seenInfoHash.has(infoHash)) continue;
      seenInfoHash.add(infoHash);
    } else if (r.streamUrl) {
      if (seenStreamUrl.has(r.streamUrl)) continue;
      seenStreamUrl.add(r.streamUrl);
    }

    deduped.push(r);
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// Public return shape
// ---------------------------------------------------------------------------

export interface StremioSearchOutcome {
  results: StremioStreamResult[];
  errors: Array<{ addonId: string; addonName: string; code: "fetch" | "timeout" | "invalid" }>;
}

// ---------------------------------------------------------------------------
// Fan-out search
// ---------------------------------------------------------------------------

async function fanOut(
  path: string,
  enabledAddons: Array<{ id: string; url: string; name: string; enabled: boolean }>,
  dispatcher: Dispatcher | undefined,
  cacheKey: string,
): Promise<StremioSearchOutcome> {
  // Check cache — cache only stores the result list (errors are transient)
  const cached = cache.get(cacheKey);
  if (cached) return { results: cached, errors: [] };

  const settledResults = await Promise.allSettled(
    enabledAddons.map((addon) => callOneAddon(addon.url, addon.name, path, dispatcher)),
  );

  const allResults: StremioStreamResult[] = [];
  const errors: StremioSearchOutcome["errors"] = [];

  for (let i = 0; i < settledResults.length; i++) {
    const result = settledResults[i]!;
    const addon = enabledAddons[i]!;
    if (result.status === "fulfilled") {
      allResults.push(...result.value);
    } else {
      // Classify the error reason into a code.
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      let code: "fetch" | "timeout" | "invalid" = "fetch";
      if (msg.includes("timeout") || msg.includes("TimeoutError") || msg.includes("AbortError")) {
        code = "timeout";
      } else if (msg.includes("invalid JSON") || msg.includes("Invalid JSON")) {
        code = "invalid";
      }
      errors.push({ addonId: addon.id, addonName: addon.name, code });
    }
  }

  const deduped = dedupeResults(allResults);
  // Primary sort by quality rank; secondary stable boost for HTTP-shape (streamUrl set)
  // over magnet-shape within the same rank bucket — instant CDN streams rank above P2P.
  deduped.sort((a, b) => {
    const primary = rankTorrent(a, b);
    if (primary !== 0) return primary;
    if (a.streamUrl && !b.streamUrl) return -1;
    if (b.streamUrl && !a.streamUrl) return 1;
    return 0;
  });

  cache.set(cacheKey, deduped);
  return { results: deduped, errors };
}

// ---------------------------------------------------------------------------
// Public search API
// ---------------------------------------------------------------------------

export async function searchStremioMovie(
  imdbId: string,
  enabledAddonsOverride?: Array<{ id: string; url: string; name: string; enabled: boolean }>,
): Promise<StremioSearchOutcome> {
  if (!imdbId) return { results: [], errors: [] };

  const enabledAddons =
    enabledAddonsOverride ??
    getSettings().stremioAddons.filter((a) => a.enabled);
  if (enabledAddons.length === 0) return { results: [], errors: [] };

  console.log(`stremio: search imdb=${imdbId} via=${enabledAddons.length} addons`);

  const dispatcher = getDispatcher("stremio") as Dispatcher | undefined;
  const proxyTag = dispatcher ? "on" : "off";
  const hash = addonsHash(enabledAddons);
  const path = `/stream/movie/${encodeURIComponent(imdbId)}.json`;
  const cacheKey = `${path}::${hash}::proxy:${proxyTag}`;

  return fanOut(path, enabledAddons, dispatcher, cacheKey);
}

export async function searchStremioEpisode(
  imdbId: string,
  season: number,
  episode: number,
  enabledAddonsOverride?: Array<{ id: string; url: string; name: string; enabled: boolean }>,
): Promise<StremioSearchOutcome> {
  if (!imdbId) return { results: [], errors: [] };

  const enabledAddons =
    enabledAddonsOverride ??
    getSettings().stremioAddons.filter((a) => a.enabled);
  if (enabledAddons.length === 0) return { results: [], errors: [] };

  console.log(`stremio: search imdb=${imdbId} s=${season} e=${episode} via=${enabledAddons.length} addons`);

  const dispatcher = getDispatcher("stremio") as Dispatcher | undefined;
  const proxyTag = dispatcher ? "on" : "off";
  const hash = addonsHash(enabledAddons);
  const path = `/stream/series/${encodeURIComponent(imdbId)}:${season}:${episode}.json`;
  const cacheKey = `${path}::${hash}::proxy:${proxyTag}`;

  return fanOut(path, enabledAddons, dispatcher, cacheKey);
}

export { FALLBACK_TRACKERS };
