import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { MovieDetails, MovieSearchResult, TorrentResult } from "@castcrate/shared";
import { SearchBar } from "./components/SearchBar";
import { ResultsGrid } from "./components/ResultsGrid";
import { MovieDetail } from "./components/MovieDetail";
import { TorrentPicker } from "./components/TorrentPicker";
import { Player } from "./components/Player";
import { useDebounced } from "./hooks/useDebounced";
import { api, ApiError, type StartTorrentResult } from "./lib/api";

export default function App() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [findFor, setFindFor] = useState<MovieDetails | null>(null);
  const [session, setSession] = useState<StartTorrentResult | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const debounced = useDebounced(query, 300);

  const search = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.searchMovies(debounced),
    enabled: debounced.trim().length > 0,
  });

  const start = useMutation({
    mutationFn: (t: TorrentResult) => api.startTorrent(t.magnet),
    onSuccess: (data) => {
      setSession(data);
      setFindFor(null);
      setStartError(null);
    },
    onError: (err: Error) => {
      setStartError(err.message);
    },
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
        <div className="mt-8 flex w-full justify-center">
          <SearchBar value={query} onChange={setQuery} />
        </div>
      </header>

      <section className="mt-12">
        {search.isError && <SearchError err={search.error} />}
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

      {selectedId !== null && !findFor && !session && (
        <MovieDetail
          tmdbId={selectedId}
          onClose={() => setSelectedId(null)}
          onFindAndCast={(movie) => {
            setFindFor(movie);
            setSelectedId(null);
          }}
          findCastEnabled
        />
      )}

      {findFor && !session && (
        <TorrentPicker
          movie={findFor}
          onClose={() => {
            setFindFor(null);
            setStartError(null);
          }}
          onPick={(t) => start.mutate(t)}
        />
      )}

      {findFor && start.isPending && (
        <BlockingNotice text={`Connecting to peers for ${findFor.title}…`} />
      )}

      {startError && (
        <BlockingNotice
          text={`Failed to start torrent: ${startError}`}
          onDismiss={() => setStartError(null)}
        />
      )}

      {session && findFor && (
        <Player
          movie={findFor}
          session={session}
          onClose={() => {
            setSession(null);
            setFindFor(null);
          }}
        />
      )}
    </main>
  );
}

function BlockingNotice({
  text,
  onDismiss,
}: {
  text: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-8 py-6 text-center">
        <p className="text-zinc-200">{text}</p>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="mt-4 rounded-full bg-zinc-900 px-4 py-2 text-sm hover:bg-zinc-800"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
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
