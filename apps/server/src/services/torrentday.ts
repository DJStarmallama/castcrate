import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { load } from "cheerio";
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
import { episodeMatchesTitle } from "./knaben.js";
import type { IndexerAdapter } from "../lib/indexers.js";

export interface TorrentDayResult extends TorrentResult {
  source: "torrentday";
  torrentUrl: string;
}

export class TorrentDayAuthError extends Error {
  constructor(message = "TorrentDay auth failed — refresh cookies") {
    super(message);
    this.name = "TorrentDayAuthError";
  }
}

export class TorrentDayDisabledError extends Error {
  constructor(message = "TorrentDay is disabled or credentials are not configured") {
    super(message);
    this.name = "TorrentDayDisabledError";
  }
}

const TD_BASE = "https://www.torrentday.com";

// Category params — empty values filter to category on TD's search.
const MOVIE_CATS = "&96=&11=&5=&48=&44=&21=";
const TV_CATS = "&104=&32=&7=&34=&26=";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const cache = new LRUCache<string, TorrentDayResult[]>({
  max: 200,
  ttl: 1000 * 60 * 30, // 30 min
});

/** Clears the search result cache — for use in tests only. */
export function _clearCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Returns true when TD is enabled and both uid and pass are configured. */
export function tdAvailable(): boolean {
  const s = getSettings();
  return s.torrentDay.enabled && Boolean(s.torrentDay.uid) && Boolean(s.torrentDay.pass);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertCredentials(): { uid: string; pass: string } {
  const s = getSettings();
  const { uid, pass } = s.torrentDay;
  if (!s.torrentDay.enabled || !uid || !pass) {
    throw new TorrentDayDisabledError();
  }
  return { uid, pass };
}

/**
 * First 8 hex chars of sha1(uid + pass) — used as part of the cache key
 * to distinguish accounts without storing raw cookies in memory-observable keys.
 */
function cookieHash(uid: string, pass: string): string {
  return createHash("sha1").update(uid + pass).digest("hex").slice(0, 8);
}

function buildHeaders(uid: string, pass: string): Record<string, string> {
  return {
    Cookie: `uid=${uid}; pass=${pass}`,
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml",
  };
}

async function fetchSearchHtml(
  query: string,
  cats: string,
  uid: string,
  pass: string,
  dispatcher: Dispatcher | undefined,
): Promise<string> {
  const via = dispatcher ? "proxy" : "direct";
  // Never log uid or pass.
  console.info(`torrentday: search "${query}" via=${via}`);

  const url = `${TD_BASE}/t?q=${encodeURIComponent(query)}${cats}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: buildHeaders(uid, pass),
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
      dispatcher,
    } as UndiciRequestInit as unknown as RequestInit);
  } catch (err) {
    throw new Error(`TorrentDay fetch failed: ${(err as Error).message}`);
  }

  // 3xx with Location pointing to login → auth error.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "";
    if (location.includes("login")) {
      console.warn("torrentday: auth failed — refresh cookies");
      throw new TorrentDayAuthError();
    }
    throw new Error(`TorrentDay unexpected redirect to ${location}`);
  }

  if (!res.ok) {
    throw new Error(`TorrentDay HTTP ${res.status}`);
  }

  return res.text();
}

function parseSize(text: string): number {
  const trimmed = text.trim();
  const match = /^([\d.]+)\s*(GB|MB|KB|B)$/i.exec(trimmed);
  if (!match) return 0;
  const value = parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();
  if (unit === "GB") return Math.round(value * 1024 * 1024 * 1024);
  if (unit === "MB") return Math.round(value * 1024 * 1024);
  if (unit === "KB") return Math.round(value * 1024);
  return Math.round(value);
}

function parseSearchHtml(html: string): TorrentDayResult[] {
  const $ = load(html);

  // Auth check — if no torrent table present, assume login page.
  if ($("#torrentTable").length === 0) {
    console.warn("torrentday: auth failed — refresh cookies");
    throw new TorrentDayAuthError();
  }

  const results: TorrentDayResult[] = [];

  $("#torrentTable tbody tr").each((_i, row) => {
    const $row = $(row);

    // Title
    const titleEl = $row.find("td.torrentNameInfo a.b.hv");
    const title = titleEl.text().trim();
    if (!title) return;

    // .torrent download URL
    const dlHref = $row.find("a.tdm-dl-cell").attr("href");
    if (!dlHref) return;
    const torrentUrl = `${TD_BASE}${dlHref}`;

    // Seeds / leechers
    const seeds = parseInt($row.find("td.seedersInfo").text().trim(), 10) || 0;
    const peers = parseInt($row.find("td.leechersInfo").text().trim(), 10) || 0;

    // Drop zero-seed entries.
    if (seeds === 0) return;

    // Size
    const sizeText = $row.find("td.ac[style*='white-space:nowrap']").text().trim();
    const sizeBytes = parseSize(sizeText);

    // Quality from title
    const q = parseQuality(title);

    // Drop xvid releases.
    if (q.videoCodec === "xvid") return;

    results.push({
      title,
      magnet: "", // TD uses .torrent blobs only — magnet unused
      torrentUrl,
      size: formatBytes(sizeBytes),
      sizeBytes,
      seeds,
      peers,
      resolution: q.resolution,
      videoCodec: q.videoCodec,
      source: "torrentday",
      castFriendly: isCastFriendly(q),
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function searchTorrentDayMovie(
  title: string,
  year?: number,
): Promise<TorrentDayResult[]> {
  const { uid, pass } = assertCredentials();
  const dispatcher = getDispatcher("torrentday");
  const hash = cookieHash(uid, pass);
  const proxyTag = dispatcher ? "on" : "off";
  const key = `mov::${title.toLowerCase()}::${year ?? ""}::${hash}::proxy:${proxyTag}`;

  const cached = cache.get(key);
  if (cached) return cached;

  const query = year ? `${title} ${year}` : title;
  const html = await fetchSearchHtml(query, MOVIE_CATS, uid, pass, dispatcher);
  const results = parseSearchHtml(html);
  results.sort(rankTorrent);
  cache.set(key, results);
  return results;
}

export async function searchTorrentDayEpisode(
  title: string,
  season: number,
  episode: number,
): Promise<TorrentDayResult[]> {
  const { uid, pass } = assertCredentials();
  const dispatcher = getDispatcher("torrentday");
  const hash = cookieHash(uid, pass);
  const proxyTag = dispatcher ? "on" : "off";
  const key = `ep::${title.toLowerCase()}::${season}::${episode}::${hash}::proxy:${proxyTag}`;

  const cached = cache.get(key);
  if (cached) return cached;

  const sTag = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  const query = `${title} ${sTag}`;
  const html = await fetchSearchHtml(query, TV_CATS, uid, pass, dispatcher);
  const all = parseSearchHtml(html);

  // Filter to exact episode match.
  const results = all.filter((r) => episodeMatchesTitle(r.title, season, episode));
  results.sort(rankTorrent);
  cache.set(key, results);
  return results;
}

export async function fetchTorrentBlob(torrentUrl: string): Promise<Buffer> {
  const { uid, pass } = assertCredentials();
  const dispatcher = getDispatcher("torrentday");

  const safeUrl = encodeURI(torrentUrl);

  let res: Response;
  try {
    res = await fetch(safeUrl, {
      headers: buildHeaders(uid, pass),
      signal: AbortSignal.timeout(15_000),
      dispatcher,
    } as UndiciRequestInit as unknown as RequestInit);
  } catch (err) {
    throw new Error(`TorrentDay blob fetch failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    throw new Error(`TorrentDay blob HTTP ${res.status}`);
  }

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);

  // Validate bencode dict magic byte — 'd' (0x64).
  if (buf.length <= 100 || buf[0] !== 0x64) {
    throw new Error(
      "TorrentDay returned invalid .torrent data — credentials may have expired",
    );
  }

  return buf;
}

export { episodeMatchesTitle };

// ---------------------------------------------------------------------------
// IndexerAdapter registration. TorrentDay only runs when `tdAvailable()` is
// true (enabled + credentials present). Episode search additionally requires
// a series title, matching the old route's `title && tdAvailable()` gate.
// The `formatThrown` hook preserves the {source, code: "auth"|"fetch"}
// structured wire shape the route used to emit inline.
// ---------------------------------------------------------------------------

export const torrentdayAdapter: IndexerAdapter = {
  name: "torrentday",
  supportsMovie: true,
  supportsEpisode: true,
  supportsSeasonPack: false,
  // TD requires credentials AND, for episode search, a series title —
  // matching the old route's `title && tdAvailable()` gate.
  enabled: (query) => {
    if (!tdAvailable()) return false;
    if ("season" in query && !query.title) return false;
    return true;
  },
  searchMovie: async (query) => {
    const results = await searchTorrentDayMovie(query.title, query.year);
    return { results };
  },
  searchEpisode: async (query) => {
    const results = await searchTorrentDayEpisode(
      query.title!,
      query.season,
      query.episode,
    );
    return { results };
  },
  formatThrown: (err) => {
    if (err instanceof TorrentDayAuthError) {
      return { source: "torrentday", code: "auth" };
    }
    // All other TD errors (fetch failure, disabled, unexpected redirect) map
    // to `code: "fetch"` — matching the old route's catch-all branch.
    return { source: "torrentday", code: "fetch" };
  },
};
