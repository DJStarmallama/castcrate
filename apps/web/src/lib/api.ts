import type { MovieDetails, MovieSearchResult } from "@castcrate/shared";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string };
      detail = j.error ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new ApiError(detail || res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  searchMovies: (q: string) =>
    get<{ results: MovieSearchResult[] }>(`/api/search/movies?q=${encodeURIComponent(q)}`),
  movieDetails: (tmdbId: number) => get<MovieDetails>(`/api/movies/${tmdbId}`),
};

export { ApiError };
