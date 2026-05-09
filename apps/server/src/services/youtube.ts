import { LRUCache } from "lru-cache";

// 24h cache: trailer video IDs are stable. The wrapper `{ id }` lets us
// cache misses (id === null) too without LRUCache's non-null value constraint.
interface CachedEntry {
  id: string | null;
}
const cache = new LRUCache<string, CachedEntry>({
  max: 500,
  ttl: 1000 * 60 * 60 * 24,
});

// YouTube search results render as a JSON blob inside a <script> tag with
// `var ytInitialData = {...}`. Each genuine video result is a `videoRenderer`;
// shorts use `reelItemRenderer` and ads use `promotedSparklesWebRenderer`.
// Match the first videoRenderer to skip those.
const VIDEO_ID_RE = /"videoRenderer":\s*\{[^}]*?"videoId":"([a-zA-Z0-9_-]{11})"/;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function trailerSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

/**
 * Scrape YouTube's HTML search page for the first non-Short, non-ad video ID
 * matching the query. Returns null on miss or on a network/parse failure
 * (caller renders a "Watch on YouTube" fallback link).
 *
 * No API key required. Costs us one HTTP fetch per uncached query.
 */
export async function findTrailerVideoId(
  query: string,
): Promise<string | null> {
  const key = query.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached.id;

  const url = trailerSearchUrl(query);
  let html: string;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        // Skip the EU consent interstitial that some regions hit.
        Cookie: "CONSENT=YES+1",
      },
    });
    if (!res.ok) {
      cache.set(key, { id: null });
      return null;
    }
    html = await res.text();
  } catch {
    cache.set(key, { id: null });
    return null;
  }

  const m = VIDEO_ID_RE.exec(html);
  const id = m ? m[1]! : null;
  cache.set(key, { id });
  return id;
}
