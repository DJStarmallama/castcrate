import { LRUCache } from "lru-cache";
import type { MovieDetails, MovieSearchResult } from "@castcrate/shared";
import { config, TMDB_IMAGE_BASE } from "../lib/config.js";

const TMDB_BASE = "https://api.themoviedb.org/3";
const POSTER_SIZE = "w500";

const cache = new LRUCache<string, object>({
  max: 500,
  ttl: 1000 * 60 * 60,
});

interface TmdbSearchMovie {
  id: number;
  title: string;
  release_date: string;
  poster_path: string | null;
  vote_average: number;
  overview: string;
}

interface TmdbMovieDetails extends TmdbSearchMovie {
  runtime: number | null;
  genres: { id: number; name: string }[];
  credits?: {
    cast: { name: string; character: string }[];
  };
}

export class TmdbError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function assertKey(): string {
  if (!config.tmdbApiKey) {
    throw new TmdbError(
      "TMDB_API_KEY is not configured. Add it to .env to enable movie search.",
      503,
    );
  }
  return config.tmdbApiKey;
}

async function tmdbFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const key = assertKey();
  const url = new URL(`${TMDB_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const cacheKey = url.toString();
  const cached = cache.get(cacheKey);
  if (cached) return cached as T;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TmdbError(`TMDB ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  const json = (await res.json()) as T;
  cache.set(cacheKey, json as object);
  return json;
}

function poster(path: string | null): string | null {
  return path ? `${TMDB_IMAGE_BASE}/${POSTER_SIZE}${path}` : null;
}

function yearOf(release: string): number | null {
  if (!release) return null;
  const y = Number(release.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

function toSearchResult(m: TmdbSearchMovie): MovieSearchResult {
  return {
    tmdbId: m.id,
    title: m.title,
    year: yearOf(m.release_date),
    poster: poster(m.poster_path),
    rating: Math.round(m.vote_average * 10) / 10,
    overview: m.overview,
  };
}

export async function searchMovies(query: string): Promise<MovieSearchResult[]> {
  if (!query.trim()) return [];
  const data = await tmdbFetch<{ results: TmdbSearchMovie[] }>("/search/movie", {
    query,
    include_adult: "false",
  });
  return data.results.map(toSearchResult);
}

export async function getMovieDetails(tmdbId: number): Promise<MovieDetails> {
  const m = await tmdbFetch<TmdbMovieDetails>(`/movie/${tmdbId}`, {
    append_to_response: "credits",
  });
  return {
    ...toSearchResult(m),
    runtime: m.runtime,
    genres: m.genres.map((g) => g.name),
    cast: (m.credits?.cast ?? []).slice(0, 10).map((c) => ({
      name: c.name,
      character: c.character,
    })),
  };
}
