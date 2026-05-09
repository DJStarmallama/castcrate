import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MovieDetails } from "@castcrate/shared";
import { api } from "../lib/api";
import { useEscape } from "../hooks/useEscape";
import { TrailerView } from "./TrailerView";
import { TitleEnrichment } from "./TitleEnrichment";

interface Props {
  imdbId: string;
  onClose: () => void;
  onFindAndCast: (movie: MovieDetails) => void;
  onPickSimilar?: (t: { imdbId: string; type: "movie" | "series" }) => void;
  findCastEnabled?: boolean;
}

export function MovieDetail({
  imdbId,
  onClose,
  onFindAndCast,
  onPickSimilar,
  findCastEnabled = false,
}: Props) {
  useEscape(onClose);
  const [trailerOn, setTrailerOn] = useState(false);
  const q = useQuery<MovieDetails>({
    queryKey: ["movie", imdbId],
    queryFn: () => api.movieDetails(imdbId),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 z-10 rounded-full bg-zinc-900/80 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Close"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        {q.isPending && (
          <div className="p-12 text-center text-zinc-500">Loading…</div>
        )}
        {q.isError && (
          <div className="p-12 text-center text-red-400">
            Failed to load: {q.error.message}
          </div>
        )}
        {q.data && trailerOn && (
          <TrailerView
            title={q.data.title}
            year={q.data.year}
            onClose={() => setTrailerOn(false)}
          />
        )}
        {q.data && !trailerOn && (
          <>
            <DetailBody
              movie={q.data}
              onFindAndCast={onFindAndCast}
              findCastEnabled={findCastEnabled}
              onPlayTrailer={() => setTrailerOn(true)}
            />
            {onPickSimilar && (
              <TitleEnrichment
                imdbId={q.data.imdbId}
                title={q.data.title}
                onPickSimilar={onPickSimilar}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DetailBody({
  movie,
  onFindAndCast,
  findCastEnabled,
  onPlayTrailer,
}: {
  movie: MovieDetails;
  onFindAndCast: (movie: MovieDetails) => void;
  findCastEnabled: boolean;
  onPlayTrailer: () => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[300px_1fr]">
      <div className="aspect-[2/3] w-full overflow-hidden bg-zinc-900 md:rounded-l-2xl">
        {movie.poster ? (
          <img src={movie.poster} alt={movie.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-6xl text-zinc-700">
            {movie.title.charAt(0)}
          </div>
        )}
      </div>
      <div className="p-8">
        <h2 className="text-3xl font-semibold tracking-tight">{movie.title}</h2>
        <p className="mt-1 text-sm text-zinc-500">
          {movie.year ?? "—"}
          {movie.runtime ? ` · ${movie.runtime} min` : ""} · ★ {movie.rating.toFixed(1)}
        </p>
        {movie.genres.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {movie.genres.map((g) => (
              <span
                key={g}
                className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-400"
              >
                {g}
              </span>
            ))}
          </div>
        )}
        <p className="mt-6 leading-relaxed text-zinc-300">{movie.overview}</p>
        {movie.cast.length > 0 && (
          <div className="mt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Cast</h3>
            <p className="mt-2 text-sm text-zinc-400">
              {movie.cast
                .slice(0, 6)
                .map((c) => c.name)
                .join(", ")}
            </p>
          </div>
        )}
        <div className="mt-8 flex flex-wrap gap-3">
          <button
            onClick={() => onFindAndCast(movie)}
            disabled={!findCastEnabled}
            className="rounded-full bg-emerald-500 px-6 py-3 font-medium text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            title={findCastEnabled ? undefined : "Available in next phase"}
          >
            Find & Cast
          </button>
          <button
            onClick={onPlayTrailer}
            className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-5 py-3 font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
            Trailer
          </button>
        </div>
      </div>
    </div>
  );
}
