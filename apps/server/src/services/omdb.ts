import { LRUCache } from "lru-cache";
import type {
  ContentType,
  MovieDetails,
  MovieSearchResult,
  SeriesDetails,
  SeriesEpisode,
} from "@castcrate/shared";
import { config } from "../lib/config.js";

const OMDB_BASE = "http://www.omdbapi.com/";

const cache = new LRUCache<string, object>({
  max: 500,
  ttl: 1000 * 60 * 60,
});

export class OmdbError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface OmdbSearchItem {
  Title: string;
  Year: string;
  imdbID: string;
  Type: "movie" | "series" | "episode";
  Poster: string;
}

interface OmdbSearchResponse {
  Search?: OmdbSearchItem[];
  totalResults?: string;
  Response: "True" | "False";
  Error?: string;
}

interface OmdbDetailResponse {
  Title: string;
  Year: string;
  Rated?: string;
  Released?: string;
  Runtime?: string;
  Genre?: string;
  Director?: string;
  Writer?: string;
  Actors?: string;
  Plot?: string;
  Poster?: string;
  Metascore?: string;
  imdbRating?: string;
  imdbID: string;
  Type: string;
  totalSeasons?: string;
  Response: "True" | "False";
  Error?: string;
}

interface OmdbSeasonResponse {
  Title: string;
  Season: string;
  totalSeasons: string;
  Episodes?: {
    Title: string;
    Released: string;
    Episode: string;
    imdbRating: string;
    imdbID: string;
  }[];
  Response: "True" | "False";
  Error?: string;
}

function assertKey(): string {
  if (!config.omdbApiKey) {
    throw new OmdbError(
      "OMDB_API_KEY is not configured. Add it to .env to enable movie search.",
      503,
    );
  }
  return config.omdbApiKey;
}

async function omdbFetch<T extends { Response: "True" | "False"; Error?: string }>(
  params: Record<string, string>,
): Promise<T> {
  const key = assertKey();
  const url = new URL(OMDB_BASE);
  url.searchParams.set("apikey", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // Strip the apikey from the cache key so logs/inspection are safer.
  const cacheKey = JSON.stringify(params);
  const cached = cache.get(cacheKey);
  if (cached) return cached as T;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    const cause = (err as Error & { cause?: { code?: string } })?.cause;
    if (cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN") {
      throw new OmdbError(
        "Cannot reach omdbapi.com — DNS lookup failed. Check your network.",
        502,
      );
    }
    throw new OmdbError(`OMDb network error: ${(err as Error).message}`, 502);
  }
  if (!res.ok) {
    throw new OmdbError(`OMDb HTTP ${res.status}`, 502);
  }
  const json = (await res.json()) as T;
  if (json.Response === "False") {
    const msg = json.Error ?? "OMDb returned no results";
    if (/invalid api key/i.test(msg)) {
      throw new OmdbError(
        "OMDb rejected the API key. If you just signed up, click the activation link in the email OMDb sent you.",
        401,
      );
    }
    if (/not found|no.*result|too many results/i.test(msg)) {
      // Mid-typing or genuinely empty — let the caller render empty results.
      return json;
    }
    throw new OmdbError(msg, 502);
  }
  cache.set(cacheKey, json as object);
  return json;
}

function parseYear(year: string | undefined): number | null {
  if (!year) return null;
  const y = Number(year.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

function parseRuntime(runtime: string | undefined): number | null {
  if (!runtime) return null;
  const m = /^(\d+)/.exec(runtime);
  return m ? Number(m[1]) : null;
}

function parseRating(rating: string | undefined): number {
  if (!rating || rating === "N/A") return 0;
  const r = Number(rating);
  return Number.isFinite(r) ? r : 0;
}

function poster(p: string | undefined): string | null {
  if (!p || p === "N/A") return null;
  return p;
}

function splitList(s: string | undefined): string[] {
  if (!s || s === "N/A") return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function normalizeType(t: string): ContentType {
  return t === "series" ? "series" : "movie";
}

function searchItemToResult(item: OmdbSearchItem): MovieSearchResult {
  return {
    imdbId: item.imdbID,
    type: normalizeType(item.Type),
    title: item.Title,
    year: parseYear(item.Year),
    poster: poster(item.Poster),
    // OMDb's search response doesn't include rating; the detail call fills it.
    rating: 0,
    overview: "",
  };
}

function detailToResult(d: OmdbDetailResponse): MovieDetails {
  return {
    imdbId: d.imdbID,
    type: normalizeType(d.Type),
    title: d.Title,
    year: parseYear(d.Year),
    poster: poster(d.Poster),
    rating: parseRating(d.imdbRating),
    overview: d.Plot && d.Plot !== "N/A" ? d.Plot : "",
    runtime: parseRuntime(d.Runtime),
    genres: splitList(d.Genre),
    cast: splitList(d.Actors).map((name) => ({ name, character: "" })),
  };
}

export async function search(query: string): Promise<MovieSearchResult[]> {
  if (!query.trim()) return [];
  // OMDb's basic search returns up to 10 results across all types.
  // Run a movie pass + series pass and merge so series aren't crowded out.
  const [movieData, seriesData] = await Promise.all([
    omdbFetch<OmdbSearchResponse>({ s: query, type: "movie" }).catch((err) => {
      if (err instanceof OmdbError && err.status === 502 && /no.*result/i.test(err.message))
        return { Response: "False" } as OmdbSearchResponse;
      throw err;
    }),
    omdbFetch<OmdbSearchResponse>({ s: query, type: "series" }).catch((err) => {
      if (err instanceof OmdbError && err.status === 502 && /no.*result/i.test(err.message))
        return { Response: "False" } as OmdbSearchResponse;
      throw err;
    }),
  ]);
  const movies = (movieData.Search ?? []).map(searchItemToResult);
  const series = (seriesData.Search ?? []).map(searchItemToResult);
  // Interleave but keep movies slightly favored in tied positions
  const out: MovieSearchResult[] = [];
  const max = Math.max(movies.length, series.length);
  for (let i = 0; i < max; i++) {
    if (movies[i]) out.push(movies[i]!);
    if (series[i]) out.push(series[i]!);
  }
  return out;
}

export async function getMovieDetails(imdbId: string): Promise<MovieDetails> {
  if (!/^tt\d+$/.test(imdbId)) {
    throw new OmdbError("invalid IMDb ID", 400);
  }
  const data = await omdbFetch<OmdbDetailResponse>({
    i: imdbId,
    plot: "full",
  });
  if (data.Response === "False") {
    throw new OmdbError(data.Error ?? "movie not found", 404);
  }
  return detailToResult(data);
}

export async function getSeriesDetails(imdbId: string): Promise<SeriesDetails> {
  if (!/^tt\d+$/.test(imdbId)) {
    throw new OmdbError("invalid IMDb ID", 400);
  }
  const data = await omdbFetch<OmdbDetailResponse>({
    i: imdbId,
    plot: "full",
  });
  if (data.Response === "False") {
    throw new OmdbError(data.Error ?? "series not found", 404);
  }
  const base = detailToResult(data);
  const totalSeasons = Number(data.totalSeasons);
  return {
    ...base,
    type: "series",
    totalSeasons: Number.isFinite(totalSeasons) ? totalSeasons : 0,
  };
}

export async function getSeasonEpisodes(
  imdbId: string,
  season: number,
): Promise<SeriesEpisode[]> {
  if (!/^tt\d+$/.test(imdbId)) {
    throw new OmdbError("invalid IMDb ID", 400);
  }
  if (!Number.isInteger(season) || season < 1) {
    throw new OmdbError("season must be a positive integer", 400);
  }
  const data = await omdbFetch<OmdbSeasonResponse>({
    i: imdbId,
    Season: String(season),
  });
  if (data.Response === "False") {
    throw new OmdbError(data.Error ?? "season not found", 404);
  }
  return (data.Episodes ?? []).map((e) => ({
    imdbId: e.imdbID,
    seriesImdbId: imdbId,
    season,
    episode: Number(e.Episode),
    title: e.Title,
    released: e.Released && e.Released !== "N/A" ? e.Released : null,
    rating: parseRating(e.imdbRating),
    overview: "",
  }));
}
