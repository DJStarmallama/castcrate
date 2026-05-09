import { LRUCache } from "lru-cache";

const ENDPOINT =
  process.env.JUSTWATCH_GRAPHQL ?? "https://apis.justwatch.com/graphql";
const POSTER_BASE = "https://images.justwatch.com";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface DiscoverTitle {
  jwId: string;
  imdbId: string | null;
  type: "movie" | "series";
  title: string;
  year: number | null;
  poster: string | null;
  overview: string;
  rating: number;
  votes: number;
  genres: string[];
}

export interface DiscoverFilter {
  country?: string;
  packages?: string[];
  genres?: string[];
  objectTypes?: ("MOVIE" | "SHOW")[];
  first?: number;
}

const popularCache = new LRUCache<string, DiscoverTitle[]>({
  max: 200,
  ttl: 1000 * 60 * 60, // 1h
});
const genresCache = new LRUCache<string, { shortName: string; name: string }[]>({
  max: 1,
  ttl: 1000 * 60 * 60 * 24, // 24h — genres don't change
});

const POPULAR_QUERY = `
  query Pop($country: Country!, $first: Int!, $filter: TitleFilter) {
    popularTitles(country: $country, first: $first, filter: $filter) {
      edges {
        node {
          id
          objectType
          content(country: $country, language: "en") {
            title
            originalReleaseYear
            shortDescription
            posterUrl
            externalIds { imdbId }
            scoring { imdbScore imdbVotes }
            genres { shortName }
          }
        }
      }
    }
  }
`;

const GENRES_QUERY = `
  query Genres { genres { shortName translation(language: "en") } }
`;

interface JwHit {
  id: string;
  objectType: "MOVIE" | "SHOW";
  content: {
    title?: string;
    originalReleaseYear?: number;
    shortDescription?: string;
    posterUrl?: string;
    externalIds?: { imdbId?: string };
    scoring?: { imdbScore?: number; imdbVotes?: number };
    genres?: { shortName: string }[];
  } | null;
}

interface PopularResponse {
  data?: { popularTitles?: { edges?: { node: JwHit }[] } };
  errors?: { message: string }[];
}

interface GenresResponse {
  data?: { genres?: { shortName: string; translation: string }[] };
  errors?: { message: string }[];
}

function buildPosterUrl(template: string | undefined, profile = "s276"): string | null {
  if (!template) return null;
  const path = template.replace("{profile}", profile).replace("{format}", "webp");
  return `${POSTER_BASE}${path}`;
}

function toDiscoverTitle(hit: JwHit): DiscoverTitle | null {
  const c = hit.content;
  if (!c?.title) return null;
  return {
    jwId: hit.id,
    imdbId: c.externalIds?.imdbId ?? null,
    type: hit.objectType === "MOVIE" ? "movie" : "series",
    title: c.title,
    year: c.originalReleaseYear ?? null,
    poster: buildPosterUrl(c.posterUrl),
    overview: c.shortDescription ?? "",
    rating: c.scoring?.imdbScore ?? 0,
    votes: c.scoring?.imdbVotes ?? 0,
    genres: c.genres?.map((g) => g.shortName) ?? [],
  };
}

async function postJustWatch<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UA,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new Error(`JustWatch fetch failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`JustWatch ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getPopularTitles(
  f: DiscoverFilter = {},
): Promise<DiscoverTitle[]> {
  const country = f.country ?? "AU";
  const first = f.first ?? 18;
  const packages = f.packages ?? [];
  const genres = f.genres ?? [];
  const objectTypes = f.objectTypes ?? [];

  const cacheKey = JSON.stringify({ country, first, packages, genres, objectTypes });
  const cached = popularCache.get(cacheKey);
  if (cached) return cached;

  const filter: Record<string, unknown> = {};
  if (packages.length) filter.packages = packages;
  if (genres.length) filter.genres = genres;
  if (objectTypes.length) filter.objectTypes = objectTypes;

  const json = await postJustWatch<PopularResponse>(POPULAR_QUERY, {
    country,
    first,
    filter: Object.keys(filter).length > 0 ? filter : null,
  });
  if (json.errors?.length) {
    throw new Error(`JustWatch: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const edges = json.data?.popularTitles?.edges ?? [];
  const titles = edges
    .map((e) => toDiscoverTitle(e.node))
    .filter((t): t is DiscoverTitle => t !== null);
  popularCache.set(cacheKey, titles);
  return titles;
}

export async function getGenres(): Promise<{ shortName: string; name: string }[]> {
  const cached = genresCache.get("all");
  if (cached) return cached;
  const json = await postJustWatch<GenresResponse>(GENRES_QUERY, {});
  if (json.errors?.length) {
    throw new Error(`JustWatch: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  const out = (json.data?.genres ?? []).map((g) => ({
    shortName: g.shortName,
    name: g.translation,
  }));
  genresCache.set("all", out);
  return out;
}
