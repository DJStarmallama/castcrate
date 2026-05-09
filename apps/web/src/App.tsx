import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  MovieDetails,
  MovieSearchResult,
  SeriesDetails,
  SeriesEpisode,
  TorrentResult,
} from "@castcrate/shared";
import { SearchBar } from "./components/SearchBar";
import { ResultsGrid } from "./components/ResultsGrid";
import { MovieDetail } from "./components/MovieDetail";
import { SeriesDetail } from "./components/SeriesDetail";
import { TorrentPicker } from "./components/TorrentPicker";
import { EpisodePicker } from "./components/EpisodePicker";
import { Player } from "./components/Player";
import { Library } from "./components/Library";
import { Settings } from "./components/Settings";
import { useDebounced } from "./hooks/useDebounced";
import { useGlobalShortcut } from "./hooks/useGlobalShortcut";
import { api, ApiError, type StartTorrentResult } from "./lib/api";

interface SelectedItem {
  imdbId: string;
  type: "movie" | "series";
}

interface EpisodeSelection {
  series: SeriesDetails;
  episode: SeriesEpisode;
}

export default function App() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [findFor, setFindFor] = useState<MovieDetails | null>(null);
  const [pickEpisode, setPickEpisode] = useState<EpisodeSelection | null>(null);
  const [session, setSession] = useState<StartTorrentResult | null>(null);
  const [sessionTitle, setSessionTitle] = useState<{
    title: string;
    poster: string | null;
  } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounced(query, 300);

  useGlobalShortcut({ key: "k", meta: true }, (e) => {
    e.preventDefault();
    searchRef.current?.focus();
    searchRef.current?.select();
  });

  const search = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.search(debounced),
    enabled: debounced.trim().length > 0,
  });

  const start = useMutation({
    mutationFn: (params: {
      torrent: TorrentResult;
      title: string;
      posterUrl: string | null;
      imdbId: string;
    }) =>
      api.startTorrent({
        magnet: params.torrent.magnet,
        title: params.title,
        posterUrl: params.posterUrl,
        imdbId: params.imdbId,
        resolution: params.torrent.resolution,
      }),
    onSuccess: (data, params) => {
      setSession(data);
      setSessionTitle({ title: params.title, poster: params.posterUrl });
      setStartError(null);
    },
    onError: (err: Error) => setStartError(err.message),
  });

  const startMovie = (t: TorrentResult) => {
    if (!findFor) return;
    start.mutate({
      torrent: t,
      title: findFor.title,
      posterUrl: findFor.poster,
      imdbId: findFor.imdbId,
    });
  };

  const startEpisode = (t: TorrentResult) => {
    if (!pickEpisode) return;
    const { series, episode } = pickEpisode;
    const epTag = `S${episode.season}E${String(episode.episode).padStart(2, "0")}`;
    start.mutate({
      torrent: t,
      title: `${series.title} ${epTag}${episode.title ? ` — ${episode.title}` : ""}`,
      posterUrl: series.poster,
      imdbId: series.imdbId,
    });
  };

  const closePlayer = () => {
    setSession(null);
    setSessionTitle(null);
    setFindFor(null);
    setPickEpisode(null);
  };

  const showHero = !debounced.trim();
  const playerMovie =
    sessionTitle && session
      ? ({
          imdbId: pickEpisode?.series.imdbId ?? findFor?.imdbId ?? "",
          type: "movie",
          title: sessionTitle.title,
          year: null,
          poster: sessionTitle.poster,
          rating: 0,
          overview: "",
          runtime: null,
          genres: [],
          cast: [],
        } satisfies MovieDetails)
      : null;

  return (
    <main className="mx-auto flex min-h-full max-w-7xl flex-col px-6 py-6">
      <nav className="flex items-center justify-end gap-2">
        <button
          onClick={() => setShowLibrary(true)}
          className="rounded-full px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
        >
          Library
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="rounded-full px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
        >
          Settings
        </button>
      </nav>

      <header
        className={`flex flex-col items-center transition-all ${
          showHero ? "mt-24" : "mt-2"
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
          <SearchBar ref={searchRef} value={query} onChange={setQuery} />
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
            onSelect={(m: MovieSearchResult) =>
              setSelected({ imdbId: m.imdbId, type: m.type })
            }
          />
        )}
        {search.data && search.data.results.length === 0 && debounced.trim() && (
          <div className="text-center text-zinc-500">
            No results for "{debounced}"
          </div>
        )}
      </section>

      {selected?.type === "movie" && !findFor && !session && (
        <MovieDetail
          imdbId={selected.imdbId}
          onClose={() => setSelected(null)}
          onFindAndCast={(movie) => {
            setFindFor(movie);
            setSelected(null);
          }}
          findCastEnabled
        />
      )}

      {selected?.type === "series" && !pickEpisode && !session && (
        <SeriesDetail
          imdbId={selected.imdbId}
          onClose={() => setSelected(null)}
          onPickEpisode={(series, episode) => {
            setPickEpisode({ series, episode });
            setSelected(null);
          }}
        />
      )}

      {findFor && !session && (
        <TorrentPicker
          movie={findFor}
          onClose={() => {
            setFindFor(null);
            setStartError(null);
          }}
          onPick={startMovie}
        />
      )}

      {pickEpisode && !session && (
        <EpisodePicker
          series={pickEpisode.series}
          episode={pickEpisode.episode}
          onClose={() => {
            setPickEpisode(null);
            setStartError(null);
          }}
          onPick={startEpisode}
        />
      )}

      {start.isPending && (
        <BlockingNotice text="Connecting to peers…" />
      )}

      {startError && (
        <BlockingNotice
          text={`Failed to start torrent: ${startError}`}
          onDismiss={() => setStartError(null)}
        />
      )}

      {session && playerMovie && (
        <Player movie={playerMovie} session={session} onClose={closePlayer} />
      )}

      {showLibrary && <Library onClose={() => setShowLibrary(false)} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
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
  const isInvalidKey = isApiError && err.status === 401;
  return (
    <div className="mx-auto max-w-2xl rounded-lg border border-amber-700/40 bg-amber-950/30 p-6 text-amber-200">
      <h3 className="font-semibold">
        {isNoKey
          ? "OMDb API key not configured"
          : isInvalidKey
            ? "OMDb rejected the API key"
            : "Search failed"}
      </h3>
      <p className="mt-2 text-sm text-amber-200/80">{err.message}</p>
      {isNoKey && (
        <p className="mt-3 text-sm text-amber-200/70">
          Get a free key at{" "}
          <a
            className="underline"
            href="https://www.omdbapi.com/apikey.aspx"
            target="_blank"
            rel="noreferrer"
          >
            omdbapi.com/apikey.aspx
          </a>{" "}
          and add it to <code>.env</code> as <code>OMDB_API_KEY</code>.
        </p>
      )}
    </div>
  );
}
