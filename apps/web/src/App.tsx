import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MovieSearchResult } from "@castcrate/shared";
import { SearchBar } from "./components/SearchBar";
import { ResultsGrid } from "./components/ResultsGrid";
import { MovieDetail } from "./components/MovieDetail";
import { useDebounced } from "./hooks/useDebounced";
import { api, ApiError } from "./lib/api";

export default function App() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const debounced = useDebounced(query, 300);

  const search = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.searchMovies(debounced),
    enabled: debounced.trim().length > 0,
  });

  const showHero = !debounced.trim();

  return (
    <main className="mx-auto flex min-h-full max-w-7xl flex-col px-6 py-10">
      <header
        className={`flex flex-col items-center transition-all ${
          showHero ? "mt-32" : "mt-2"
        }`}
      >
        <h1
          className={`font-semibold tracking-tight transition-all ${
            showHero ? "text-7xl" : "text-3xl"
          }`}
        >
          CastCrate
        </h1>
        {showHero && (
          <p className="mt-3 text-lg text-zinc-400">Search. Find. Cast.</p>
        )}
        <div className="mt-8 w-full flex justify-center">
          <SearchBar value={query} onChange={setQuery} />
        </div>
      </header>

      <section className="mt-12">
        {search.isError && (
          <SearchError err={search.error} />
        )}
        {search.isPending && debounced.trim() && (
          <div className="text-center text-zinc-500">Searching…</div>
        )}
        {search.data && (
          <ResultsGrid
            results={search.data.results}
            onSelect={(m: MovieSearchResult) => setSelectedId(m.tmdbId)}
          />
        )}
        {search.data && search.data.results.length === 0 && debounced.trim() && (
          <div className="text-center text-zinc-500">
            No results for "{debounced}"
          </div>
        )}
      </section>

      {selectedId !== null && (
        <MovieDetail
          tmdbId={selectedId}
          onClose={() => setSelectedId(null)}
          onFindAndCast={() => {
            // Phase 2 will wire this up
          }}
          findCastEnabled={false}
        />
      )}
    </main>
  );
}

function SearchError({ err }: { err: Error }) {
  const isApiError = err instanceof ApiError;
  const isNoKey = isApiError && err.status === 503;
  return (
    <div className="mx-auto max-w-2xl rounded-lg border border-amber-700/40 bg-amber-950/30 p-6 text-amber-200">
      <h3 className="font-semibold">
        {isNoKey ? "TMDB API key not configured" : "Search failed"}
      </h3>
      <p className="mt-2 text-sm text-amber-200/80">{err.message}</p>
      {isNoKey && (
        <p className="mt-3 text-sm text-amber-200/70">
          Get a free key at{" "}
          <a
            className="underline"
            href="https://www.themoviedb.org/settings/api"
            target="_blank"
            rel="noreferrer"
          >
            themoviedb.org/settings/api
          </a>{" "}
          and add it to <code>.env</code> as <code>TMDB_API_KEY</code>.
        </p>
      )}
    </div>
  );
}
