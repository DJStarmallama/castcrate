import { LRUCache } from "lru-cache";
import type { TorrentResult } from "@castcrate/shared";
import type { RequestInit as UndiciRequestInit } from "undici";
import { getDispatcher } from "../lib/proxy.js";

const EZTV_BASE = process.env.EZTV_BASE_URL ?? "https://eztvx.to/api";

const cache = new LRUCache<string, EztvTorrent[]>({
  max: 100,
  ttl: 1000 * 60 * 60,
});

export interface EztvTorrent {
  id: number;
  hash: string;
  filename: string;
  title: string;
  imdb_id: string;
  // EZTV returns these as JSON strings, not numbers.
  season: string | number;
  episode: string | number;
  seeds: number;
  peers: number;
  size_bytes: string | number;
  torrent_url: string;
  magnet_url: string;
  date_released_unix: number;
}

function asInt(v: string | number | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number.parseInt(v, 10);
  return NaN;
}

interface EztvResponse {
  imdb_id?: string;
  torrents_count?: number;
  limit?: number;
  page?: number;
  torrents?: EztvTorrent[];
}

interface ParsedQuality {
  resolution: TorrentResult["resolution"];
  videoCodec: string;
}

const RES_PATTERNS: { re: RegExp; res: TorrentResult["resolution"] }[] = [
  { re: /\b2160p\b|\b4k\b/i, res: "2160p" },
  { re: /\b1080p\b/i, res: "1080p" },
  { re: /\b720p\b/i, res: "720p" },
  { re: /\b480p\b/i, res: "480p" },
];

const CODEC_PATTERNS: { re: RegExp; codec: string }[] = [
  { re: /\b(x265|h\.?265|hevc)\b/i, codec: "x265" },
  { re: /\b(x264|h\.?264)\b/i, codec: "x264" },
  { re: /\bxvid\b/i, codec: "xvid" },
  { re: /\bav1\b/i, codec: "av1" },
];

export function parseQuality(filename: string, title: string): ParsedQuality {
  const haystack = `${filename} ${title}`;
  let resolution: TorrentResult["resolution"] = "unknown";
  for (const p of RES_PATTERNS) {
    if (p.re.test(haystack)) {
      resolution = p.res;
      break;
    }
  }
  let videoCodec = "unknown";
  for (const c of CODEC_PATTERNS) {
    if (c.re.test(haystack)) {
      videoCodec = c.codec;
      break;
    }
  }
  return { resolution, videoCodec };
}

function isCastFriendly(q: ParsedQuality): boolean {
  // Default Media Receiver: H.264 in MP4. Newer Chromecasts handle HEVC,
  // but conservatively flag x264 only as guaranteed-friendly.
  return q.videoCodec === "x264";
}

function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function rankResolution(r: TorrentResult["resolution"]): number {
  if (r === "1080p") return 4;
  if (r === "720p") return 3;
  if (r === "2160p") return 2; // higher bandwidth, deprioritise
  if (r === "480p") return 1;
  return 0;
}

function rankCodec(c: string): number {
  // x264 first (Chromecast-native), then unknown (often actually H.264),
  // then x265, then everything else.
  if (c === "x264") return 4;
  if (c === "unknown") return 3;
  if (c === "x265") return 2;
  if (c === "av1") return 1;
  return 0;
}

export function rank(a: TorrentResult, b: TorrentResult): number {
  // castFriendly first, then resolution, then codec, then seeds
  const cf = Number(b.castFriendly) - Number(a.castFriendly);
  if (cf !== 0) return cf;
  const rs = rankResolution(b.resolution) - rankResolution(a.resolution);
  if (rs !== 0) return rs;
  const cd = rankCodec(b.videoCodec) - rankCodec(a.videoCodec);
  if (cd !== 0) return cd;
  return b.seeds - a.seeds;
}

export function toResult(t: EztvTorrent): TorrentResult | null {
  if (!t.magnet_url) return null;
  const q = parseQuality(t.filename ?? "", t.title ?? "");
  if (q.videoCodec === "xvid") return null; // skip ancient codecs
  const sizeBytes = typeof t.size_bytes === "string" ? Number(t.size_bytes) : t.size_bytes;
  return {
    title: t.title,
    magnet: t.magnet_url,
    size: formatSize(sizeBytes || 0),
    sizeBytes: sizeBytes || 0,
    seeds: t.seeds ?? 0,
    peers: t.peers ?? 0,
    resolution: q.resolution,
    videoCodec: q.videoCodec,
    source: "eztv",
    season: asInt(t.season),
    episode: asInt(t.episode),
    castFriendly: isCastFriendly(q),
  };
}

async function fetchAllTorrents(imdbId: string): Promise<EztvTorrent[]> {
  // Strip "tt" prefix; EZTV expects bare numeric ID.
  const numericId = imdbId.replace(/^tt/, "");
  const dispatcher = getDispatcher("eztv");
  const cacheKey = `${numericId}::proxy:${dispatcher ? "on" : "off"}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const all: EztvTorrent[] = [];
  // Cap pages so unusually huge series (5000+ episodes) don't kill us.
  const MAX_PAGES = 5;
  const PAGE_SIZE = 100;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(`${EZTV_BASE}/get-torrents`);
    url.searchParams.set("imdb_id", numericId);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));

    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" }, dispatcher } as UndiciRequestInit as unknown as RequestInit);
    } catch (err) {
      const cause = (err as Error & { cause?: { code?: string } })?.cause;
      if (cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN") {
        throw new Error(
          `Cannot reach EZTV API at ${EZTV_BASE}. EZTV rotates domains; ` +
            `set EZTV_BASE_URL in .env to a working mirror, or use a VPN.`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      throw new Error(`EZTV ${res.status}`);
    }
    const data = (await res.json()) as EztvResponse;
    const batch = data.torrents ?? [];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  cache.set(cacheKey, all);
  return all;
}

export async function searchEpisode(
  imdbId: string,
  season: number,
  episode: number,
): Promise<TorrentResult[]> {
  const all = await fetchAllTorrents(imdbId);
  const matching = all
    .filter((t) => asInt(t.season) === season && asInt(t.episode) === episode)
    .map(toResult)
    .filter((r): r is TorrentResult => r !== null);
  matching.sort(rank);
  return matching;
}

export async function searchSeasonPack(
  imdbId: string,
  season: number,
): Promise<TorrentResult[]> {
  // EZTV represents season packs as episode = 0 for the chosen season.
  const all = await fetchAllTorrents(imdbId);
  const packs = all
    .filter((t) => asInt(t.season) === season && asInt(t.episode) === 0)
    .map(toResult)
    .filter((r): r is TorrentResult => r !== null);
  packs.sort(rank);
  return packs;
}
