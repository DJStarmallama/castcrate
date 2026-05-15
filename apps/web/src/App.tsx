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
import { Theatre } from "./components/Theatre";
import { Discover } from "./components/Discover";
import { StreamWarning } from "./components/StreamWarning";
import { useDebounced } from "./hooks/useDebounced";
import { useGlobalShortcut } from "./hooks/useGlobalShortcut";
import { useWsBridge } from "./hooks/useWsBridge";
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
  const [showTdWarning, setShowTdWarning] = useState(false);
  const [typeFilter, setTypeFilter] = useState<"all" | "movie" | "series">("all");
  // Stremio HEVC confirm: holds a pending pick when user selects a non-castFriendly
  // Stremio HTTP-stream result. Cleared on confirm or cancel.
  const [hevcPendingPick, setHevcPendingPick] = useState<{
    torrent: TorrentResult;
    title: string;
    posterUrl: string | null;
    imdbId: string;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounced(query, 300);
  // Stream torrent + cast state pushes from /ws into the TanStack Query cache.
  // REST endpoints remain as the slow-poll fallback when the WS drops.
  useWsBridge();

  useGlobalShortcut({ key: "k", meta: true }, (e) => {
    e.preventDefault();
    searchRef.current?.focus();
    searchRef.current?.select();
  });

  const search = useQuery({
    queryKey: ["search", debounced, typeFilter],
    queryFn: () =>
      api.search(debounced, typeFilter === "all" ? undefined : typeFilter),
    // OMDb requires ≥3 chars for meaningful results — anything shorter
    // either errors with "Too many results" or wastes our quota.
    enabled: debounced.trim().length >= 3,
  });

  const TD_WARNING_KEY = "castcrate.tdRatioWarning.dismissed";

  const start = useMutation({
    mutationFn: (params: {
      torrent: TorrentResult;
      title: string;
      posterUrl: string | null;
      imdbId: string;
    }) => {
      const t = params.torrent;
      // Stremio HTTP-shape: server returns the external URL directly, bypassing webtorrent.
      if (t.source === "stremio" && t.streamUrl) {
        return api.startTorrent({
          streamUrl: t.streamUrl,
          source: "stremio",
          title: params.title,
          posterUrl: params.posterUrl,
          imdbId: params.imdbId,
          resolution: t.resolution,
          videoCodec: t.videoCodec,
        });
      }
      return api.startTorrent({
        magnet: t.source === "torrentday" ? undefined : t.magnet,
        torrentUrl: t.torrentUrl,
        source: t.source,
        title: params.title,
        posterUrl: params.posterUrl,
        imdbId: params.imdbId,
        resolution: t.resolution,
        videoCodec: t.videoCodec,
      });
    },
    onSuccess: (data, params) => {
      setSession(data);
      setSessionTitle({ title: params.title, poster: params.posterUrl });
      setStartError(null);
      if (
        params.torrent.source === "torrentday" &&
        localStorage.getItem(TD_WARNING_KEY) !== "1"
      ) {
        setShowTdWarning(true);
      }
    },
    onError: (err: Error) => setStartError(err.message),
  });

  // Returns true when a pick should be paused for the HEVC confirm dialog.
  // Only applies to Stremio HTTP-shape (streamUrl set) + non-castFriendly.
  // Magnet-based Stremio results go through ffmpeg transcode; local <video>
  // handles HEVC natively — neither needs the warning.
  const isHevcHttpPick = (t: TorrentResult) =>
    t.source === "stremio" && Boolean(t.streamUrl) && !t.castFriendly;

  const startMovie = (t: TorrentResult) => {
    if (!findFor) return;
    const pick = {
      torrent: t,
      title: findFor.title,
      posterUrl: findFor.poster,
      imdbId: findFor.imdbId,
    };
    if (isHevcHttpPick(t)) {
      setHevcPendingPick(pick);
      return;
    }
    start.mutate(pick);
  };

  const startEpisode = (t: TorrentResult) => {
    if (!pickEpisode) return;
    const { series, episode } = pickEpisode;
    const epTag = `S${episode.season}E${String(episode.episode).padStart(2, "0")}`;
    const pick = {
      torrent: t,
      title: `${series.title} ${epTag}${episode.title ? ` — ${episode.title}` : ""}`,
      posterUrl: series.poster,
      imdbId: series.imdbId,
    };
    if (isHevcHttpPick(t)) {
      setHevcPendingPick(pick);
      return;
    }
    start.mutate(pick);
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
    <>
      <Theatre />
      <main className="relative z-10 mx-auto flex min-h-full max-w-7xl flex-col px-6 py-6">
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
          style={{
            color: "#f7e8b8",
            textShadow: "0 2px 8px rgba(0,0,0,0.6), 0 0 32px rgba(255, 200, 140, 0.25)",
            fontFamily: "'Playfair Display', Georgia, serif",
          }}
        >
          Llama Spit Stream
        </h1>
        {showHero && (
          <p
            className="mt-3 text-lg italic tracking-wide"
            style={{ color: "#d4b894" }}
          >
            Tonight's feature presentation
          </p>
        )}
        <div className="mt-8 flex w-full justify-center">
          <SearchBar ref={searchRef} value={query} onChange={setQuery} />
        </div>
      </header>

      {debounced.trim().length >= 3 && (
        <div className="mt-8 flex justify-center gap-2">
          <FilterPill active={typeFilter === "all"} onClick={() => setTypeFilter("all")}>
            All
          </FilterPill>
          <FilterPill active={typeFilter === "movie"} onClick={() => setTypeFilter("movie")}>
            Movies
          </FilterPill>
          <FilterPill
            active={typeFilter === "series"}
            onClick={() => setTypeFilter("series")}
          >
            TV
          </FilterPill>
        </div>
      )}

      <section className="mt-8">
        {search.isError && <SearchError err={search.error} />}
        {search.isFetching && debounced.trim().length >= 3 && (
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
        {search.data && search.data.results.length === 0 && (
          <div className="text-center text-zinc-500">
            No results for "{debounced}"
          </div>
        )}
        {debounced.trim().length > 0 && debounced.trim().length < 3 && (
          <div className="text-center text-sm text-zinc-600">
            Keep typing — at least 3 characters.
          </div>
        )}
      </section>

      {showHero && (
        <Discover
          onPickTitle={(t) => setSelected({ imdbId: t.imdbId, type: t.type })}
        />
      )}

      {selected?.type === "movie" && !findFor && !session && (
        <MovieDetail
          imdbId={selected.imdbId}
          onClose={() => setSelected(null)}
          onFindAndCast={(movie) => {
            setFindFor(movie);
            setSelected(null);
          }}
          onPickSimilar={(t) => setSelected(t)}
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
          onPickSimilar={(t) => setSelected(t)}
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
      {showTdWarning && (
        <StreamWarning
          onDismiss={() => {
            localStorage.setItem("castcrate.tdRatioWarning.dismissed", "1");
            setShowTdWarning(false);
          }}
        />
      )}
      {hevcPendingPick && (
        <HevcCastConfirm
          onCancel={() => setHevcPendingPick(null)}
          onConfirm={() => {
            const pick = hevcPendingPick;
            setHevcPendingPick(null);
            start.mutate(pick);
          }}
        />
      )}
      </main>
    </>
  );
}

// Shown when user picks a Stremio HTTP-stream result that isn't cast-friendly
// (typically HEVC/x265). The local <video> tag handles HEVC fine, so this
// dialog only fires when it would land on a Chromecast via CastBar.
// We can't intercept at cast-time without rearchitecting CastBar, so we warn
// at pick-time instead — conservative but always accurate.
function HevcCastConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-amber-700/40 bg-zinc-950 px-8 py-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-amber-200">
          This release may not play on older Chromecasts.
        </h3>
        <p className="mt-3 text-sm text-zinc-300">
          The codec (typically HEVC/x265) is not supported by all Chromecast models. Other
          variants of the same release usually appear in the list — consider picking an x264
          1080p result instead.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-full border border-zinc-700 bg-zinc-900 px-5 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-full bg-amber-500 px-5 py-2 text-sm font-medium text-black hover:bg-amber-400"
          >
            Cast anyway
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-4 py-1.5 text-sm transition ${
        active
          ? "border-amber-300/40 bg-amber-200/15 text-amber-100"
          : "border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
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
