import { LRUCache } from "lru-cache";
import type { TorrentResult } from "@castcrate/shared";

const YTS_BASE = process.env.YTS_BASE_URL ?? "https://movies-api.accel.li/api/v2";

const TRACKERS = [
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:80",
  "udp://tracker.coppersurfer.tk:6969",
  "udp://glotorrents.pw:6969/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://exodus.desync.com:6969/announce",
];

const cache = new LRUCache<string, TorrentResult[]>({
  max: 200,
  ttl: 1000 * 60 * 60,
});

export interface YtsTorrent {
  url: string;
  hash: string;
  quality: string;
  type: string;
  seeds: number;
  peers: number;
  size: string;
  size_bytes: number;
  video_codec: string;
  audio_channels: string;
}

export interface YtsMovie {
  id: number;
  title: string;
  title_long: string;
  year: number;
  large_cover_image: string | null;
  torrents: YtsTorrent[];
}

interface YtsListResponse {
  status: string;
  data: { movie_count: number; movies?: YtsMovie[] };
}

export function buildMagnet(hash: string, title: string): string {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackers}`;
}

function isCastCompatible(t: YtsTorrent): boolean {
  const codec = t.video_codec.toLowerCase();
  return codec === "x264" || codec === "h264";
}

function rankQuality(q: string): number {
  if (q === "1080p") return 3;
  if (q === "720p") return 2;
  return 0;
}

export function toResult(t: YtsTorrent, m: YtsMovie): TorrentResult | null {
  const q = t.quality;
  if (q !== "1080p" && q !== "720p") return null;
  if (!isCastCompatible(t)) return null;
  return {
    title: `${m.title_long} [${q} ${t.video_codec}]`,
    magnet: buildMagnet(t.hash, m.title_long),
    size: t.size,
    sizeBytes: t.size_bytes,
    seeds: t.seeds,
    peers: t.peers,
    resolution: q,
    videoCodec: t.video_codec,
    source: "yts",
  };
}

export function rank(a: TorrentResult, b: TorrentResult): number {
  const qd = rankQuality(b.resolution) - rankQuality(a.resolution);
  if (qd !== 0) return qd;
  return b.seeds - a.seeds;
}

export function rankAndFilter(movies: YtsMovie[]): TorrentResult[] {
  const out: TorrentResult[] = [];
  for (const m of movies) {
    for (const t of m.torrents) {
      const r = toResult(t, m);
      if (r) out.push(r);
    }
  }
  out.sort(rank);
  return out;
}

export async function searchTorrents(title: string, year?: number): Promise<TorrentResult[]> {
  const key = `${title.toLowerCase()}::${year ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const url = new URL(`${YTS_BASE}/list_movies.json`);
  url.searchParams.set("query_term", title);
  url.searchParams.set("limit", "20");

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    const cause = (err as Error & { cause?: { code?: string } })?.cause;
    if (cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN") {
      throw new Error(
        `Cannot reach YTS API at ${YTS_BASE}. The host may have moved (YTS rotates ` +
          `domains when seized). Try setting YTS_BASE_URL in .env to a working mirror, ` +
          `or use a VPN if the issue is your ISP.`,
      );
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`YTS ${res.status}`);
  }
  const data = (await res.json()) as YtsListResponse;
  const movies = data.data.movies ?? [];

  const matched = year ? movies.filter((m) => m.year === year) : movies;
  const pool = matched.length > 0 ? matched : movies;

  const results = rankAndFilter(pool);
  cache.set(key, results);
  return results;
}
