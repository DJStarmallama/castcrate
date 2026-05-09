import { LRUCache } from "lru-cache";
import type { TorrentResult } from "@castcrate/shared";
import {
  formatBytes,
  isCastFriendly,
  parseQuality,
  rankTorrent,
} from "../lib/quality.js";

const KNABEN_API = process.env.KNABEN_BASE_URL ?? "https://api.knaben.org/v1";

const cache = new LRUCache<string, TorrentResult[]>({
  max: 200,
  ttl: 1000 * 60 * 60,
});

interface KnabenHit {
  id: string | number;
  hash?: string;
  title: string;
  seeders?: number;
  peers?: number;
  bytes?: number;
  /** Newer Knaben API. */
  magnetUrl?: string;
  /** Older response shape; kept as fallback. */
  magnet?: string;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
}

interface KnabenResponse {
  hits?: KnabenHit[];
  total?: number;
}

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:80/announce",
  "udp://exodus.desync.com:6969/announce",
];

function buildMagnet(hash: string, title: string): string {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackers}`;
}

function magnetFor(hit: KnabenHit): string | null {
  if (hit.magnetUrl) return hit.magnetUrl;
  if (hit.magnet) return hit.magnet;
  if (hit.hash) return buildMagnet(hit.hash, hit.title);
  return null;
}

async function postKnaben(body: object): Promise<KnabenResponse> {
  let res: Response;
  try {
    res = await fetch(KNABEN_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const cause = (err as Error & { cause?: { code?: string } })?.cause;
    if (cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN") {
      throw new Error(
        `Cannot reach Knaben API at ${KNABEN_API}. Set KNABEN_BASE_URL or check DNS.`,
      );
    }
    throw new Error(`Knaben fetch failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`Knaben ${res.status}`);
  }
  return (await res.json()) as KnabenResponse;
}

function toResult(hit: KnabenHit): TorrentResult | null {
  const magnet = magnetFor(hit);
  if (!magnet) return null;
  const q = parseQuality(hit.title);
  if (q.videoCodec === "xvid") return null;
  return {
    title: hit.title,
    magnet,
    size: formatBytes(hit.bytes ?? 0),
    sizeBytes: hit.bytes ?? 0,
    seeds: hit.seeders ?? 0,
    peers: hit.peers ?? 0,
    resolution: q.resolution,
    videoCodec: q.videoCodec,
    source: "knaben",
    castFriendly: isCastFriendly(q),
    ...(typeof hit.season === "number" ? { season: hit.season } : {}),
    ...(typeof hit.episode === "number" ? { episode: hit.episode } : {}),
  };
}

// True for season-pack release names: "Show.S01.COMPLETE", "Show.Season.1.WEB",
// "Show.S1.PROPER" — anything that names a season but not a specific episode.
// Word boundaries make `\bS01\b` reject `S01E05` (E is a word char).
export function seasonPackMatchesTitle(title: string, season: number): boolean {
  const sxx = String(season).padStart(2, "0");
  const sxRaw = String(season);
  const seasonPatterns = [
    new RegExp(`\\bS${sxx}\\b`, "i"),
    new RegExp(`\\bS${sxRaw}\\b`, "i"),
    new RegExp(`\\bSeason\\.?\\s*${season}\\b`, "i"),
  ];
  // Reject explicit episode tags like S01.E05 or 1x05 that the season
  // regex wouldn't catch on its own.
  const episodePatterns = [/\bE\d+\b/i, /\b\d+x\d+\b/];
  return (
    seasonPatterns.some((p) => p.test(title)) &&
    !episodePatterns.some((p) => p.test(title))
  );
}

export function episodeMatchesTitle(
  title: string,
  season: number,
  episode: number,
): boolean {
  // Common patterns: S01E05, S1E5, s01e05, 1x05, Season 1 Episode 5.
  // The non-zero-padded form (S1E5) shows up on a lot of older / niche
  // releases — without it we miss real torrents.
  const sxx = String(season).padStart(2, "0");
  const exx = String(episode).padStart(2, "0");
  const sxRaw = String(season);
  const exRaw = String(episode);
  const patterns = [
    new RegExp(`\\bS${sxx}E${exx}\\b`, "i"),
    new RegExp(`\\bS${sxRaw}E${exRaw}\\b`, "i"),
    new RegExp(`\\b${season}x${exx}\\b`, "i"),
    new RegExp(`\\b${season}x${exRaw}\\b`, "i"),
    new RegExp(`\\bSeason\\s*${season}\\b.*\\bEpisode\\s*${episode}\\b`, "i"),
  ];
  return patterns.some((p) => p.test(title));
}

export async function searchKnabenEpisode(
  seriesTitle: string,
  season: number,
  episode: number,
): Promise<TorrentResult[]> {
  const key = `ep::${seriesTitle.toLowerCase()}::${season}::${episode}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const epTag = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  const data = await postKnaben({
    query: `${seriesTitle} ${epTag}`,
    search_type: "score",
    search_field: "title",
    size: 30,
    hide_xxx: true,
    order_by: "seeders",
    order_direction: "desc",
  });

  const results: TorrentResult[] = [];
  for (const hit of data.hits ?? []) {
    const tagged = hit.season === season && hit.episode === episode;
    if (!tagged && !episodeMatchesTitle(hit.title, season, episode)) continue;
    const r = toResult(hit);
    if (!r) continue;
    // Force the S/E since Knaben might not have tagged them
    r.season = season;
    r.episode = episode;
    results.push(r);
  }
  results.sort(rankTorrent);
  cache.set(key, results);
  return results;
}

export async function searchKnabenSeasonPack(
  seriesTitle: string,
  season: number,
): Promise<TorrentResult[]> {
  const key = `pack::${seriesTitle.toLowerCase()}::${season}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const sTag = `S${String(season).padStart(2, "0")}`;
  const data = await postKnaben({
    query: `${seriesTitle} ${sTag} COMPLETE`,
    search_type: "score",
    search_field: "title",
    size: 30,
    hide_xxx: true,
    order_by: "seeders",
    order_direction: "desc",
  });

  const results: TorrentResult[] = [];
  for (const hit of data.hits ?? []) {
    if (!seasonPackMatchesTitle(hit.title, season)) continue;
    const r = toResult(hit);
    if (!r) continue;
    r.season = season;
    delete r.episode;
    results.push(r);
  }
  results.sort(rankTorrent);
  cache.set(key, results);
  return results;
}

export async function searchKnabenMovie(
  title: string,
  year?: number,
): Promise<TorrentResult[]> {
  const key = `mov::${title.toLowerCase()}::${year ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const query = year ? `${title} ${year}` : title;
  const data = await postKnaben({
    query,
    search_type: "score",
    search_field: "title",
    size: 30,
    hide_xxx: true,
    order_by: "seeders",
    order_direction: "desc",
  });

  const results: TorrentResult[] = [];
  for (const hit of data.hits ?? []) {
    const r = toResult(hit);
    if (r) results.push(r);
  }
  results.sort(rankTorrent);
  cache.set(key, results);
  return results;
}

export const _internals = { magnetFor, toResult };
