import { afterEach, describe, expect, it, vi } from "vitest";

// OMDb adapter reads the key at request time via config.omdbApiKey, which in
// turn reads process.env at module load. The env must be set BEFORE the
// dynamic import below — `beforeAll` runs too late.
process.env.OMDB_API_KEY = "test-key";

const { search, getMovieDetails, getSeriesDetails, getSeasonEpisodes, OmdbError } =
  await import("../omdb.js");

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FakeResponse {
  ok?: boolean;
  status?: number;
  json: () => Promise<unknown>;
}

function mockFetch(...responses: FakeResponse[]) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: r.json,
    });
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

const movieSearchHit = {
  Title: "Inception",
  Year: "2010",
  imdbID: "tt1375666",
  Type: "movie" as const,
  Poster: "https://example.test/p.jpg",
};

const seriesSearchHit = {
  Title: "Breaking Bad",
  Year: "2008–2013",
  imdbID: "tt0903747",
  Type: "series" as const,
  Poster: "N/A",
};

describe("omdb.search", () => {
  it("returns parsed results for type=movie", async () => {
    mockFetch({
      json: async () => ({ Response: "True", Search: [movieSearchHit] }),
    });
    const results = await search("inception-1", "movie");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      imdbId: "tt1375666",
      type: "movie",
      title: "Inception",
      year: 2010,
      poster: "https://example.test/p.jpg",
    });
  });

  it("interleaves movies and series when no type filter", async () => {
    mockFetch(
      { json: async () => ({ Response: "True", Search: [movieSearchHit] }) },
      { json: async () => ({ Response: "True", Search: [seriesSearchHit] }) },
    );
    const results = await search("interleave-1");
    expect(results.map((r) => r.type)).toEqual(["movie", "series"]);
    // "N/A" poster normalises to null
    expect(results[1]?.poster).toBeNull();
  });

  it("returns [] when OMDb reports no results (mid-typing)", async () => {
    mockFetch({
      json: async () => ({ Response: "False", Error: "Movie not found!" }),
    });
    const results = await search("xyznoresults-1", "movie");
    expect(results).toEqual([]);
  });

  it("throws OmdbError 401 for invalid API key", async () => {
    mockFetch({
      json: async () => ({ Response: "False", Error: "Invalid API key!" }),
    });
    await expect(search("badkey-1", "movie")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("maps DNS errors to OmdbError 502", async () => {
    const fn = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("getaddrinfo ENOTFOUND"), {
        cause: { code: "ENOTFOUND" },
      }),
    );
    vi.stubGlobal("fetch", fn);
    await expect(search("dnsfail-1", "movie")).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("omdb.getMovieDetails", () => {
  it("parses runtime, genres, cast, rating", async () => {
    mockFetch({
      json: async () => ({
        Response: "True",
        Title: "Inception",
        Year: "2010",
        Runtime: "148 min",
        Genre: "Action, Sci-Fi, Thriller",
        Actors: "Leonardo DiCaprio, Tom Hardy",
        Plot: "A thief who enters dreams.",
        Poster: "https://example.test/p.jpg",
        imdbRating: "8.8",
        imdbID: "tt1375666",
        Type: "movie",
      }),
    });
    const d = await getMovieDetails("tt1375666");
    expect(d).toMatchObject({
      imdbId: "tt1375666",
      title: "Inception",
      runtime: 148,
      genres: ["Action", "Sci-Fi", "Thriller"],
      rating: 8.8,
    });
    expect(d.cast).toHaveLength(2);
  });

  it("rejects malformed IMDb IDs without hitting the network", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    await expect(getMovieDetails("not-an-imdb-id")).rejects.toBeInstanceOf(
      OmdbError,
    );
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("omdb.getSeriesDetails", () => {
  it("adds totalSeasons", async () => {
    mockFetch({
      json: async () => ({
        Response: "True",
        Title: "Breaking Bad",
        Year: "2008–2013",
        imdbID: "tt0903747",
        Type: "series",
        totalSeasons: "5",
      }),
    });
    const s = await getSeriesDetails("tt0903747");
    expect(s.type).toBe("series");
    expect(s.totalSeasons).toBe(5);
  });
});

describe("omdb.getSeasonEpisodes", () => {
  it("maps the OMDb season payload to SeriesEpisode[]", async () => {
    mockFetch({
      json: async () => ({
        Response: "True",
        Title: "Breaking Bad",
        Season: "1",
        totalSeasons: "5",
        Episodes: [
          {
            Title: "Pilot",
            Released: "2008-01-20",
            Episode: "1",
            imdbRating: "9.0",
            imdbID: "tt0959621",
          },
        ],
      }),
    });
    const eps = await getSeasonEpisodes("tt0903747", 1);
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({
      imdbId: "tt0959621",
      seriesImdbId: "tt0903747",
      season: 1,
      episode: 1,
      title: "Pilot",
      rating: 9.0,
    });
  });
});
