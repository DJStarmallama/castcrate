import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SeriesDetails, SeriesEpisode } from "@castcrate/shared";
import { api } from "../lib/api";
import { useEscape } from "../hooks/useEscape";

interface Props {
  imdbId: string;
  onClose: () => void;
  onPickEpisode: (series: SeriesDetails, episode: SeriesEpisode) => void;
}

export function SeriesDetail({ imdbId, onClose, onPickEpisode }: Props) {
  useEscape(onClose);
  const series = useQuery<SeriesDetails>({
    queryKey: ["series", imdbId],
    queryFn: () => api.seriesDetails(imdbId),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative my-8 max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
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

        {series.isPending && (
          <div className="p-12 text-center text-zinc-500">Loading…</div>
        )}
        {series.isError && (
          <div className="p-12 text-center text-red-400">
            Failed to load: {series.error.message}
          </div>
        )}
        {series.data && <Body series={series.data} onPickEpisode={onPickEpisode} />}
      </div>
    </div>
  );
}

function Body({
  series,
  onPickEpisode,
}: {
  series: SeriesDetails;
  onPickEpisode: (series: SeriesDetails, episode: SeriesEpisode) => void;
}) {
  const [season, setSeason] = useState(1);

  const eps = useQuery({
    queryKey: ["episodes", series.imdbId, season],
    queryFn: () => api.seasonEpisodes(series.imdbId, season),
    enabled: series.totalSeasons > 0,
  });

  const seasons = Array.from({ length: series.totalSeasons }, (_, i) => i + 1);

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr]">
        <div className="aspect-[2/3] w-full overflow-hidden bg-zinc-900 md:rounded-l-2xl">
          {series.poster ? (
            <img src={series.poster} alt={series.title} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-6xl text-zinc-700">
              {series.title.charAt(0)}
            </div>
          )}
        </div>
        <div className="p-8">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-indigo-500/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
              TV
            </span>
            <p className="text-sm text-zinc-500">
              {series.year ?? "—"} · {series.totalSeasons} season{series.totalSeasons === 1 ? "" : "s"}
              {series.rating > 0 && ` · ★ ${series.rating.toFixed(1)}`}
            </p>
          </div>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">{series.title}</h2>
          {series.genres.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {series.genres.map((g) => (
                <span
                  key={g}
                  className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-400"
                >
                  {g}
                </span>
              ))}
            </div>
          )}
          {series.overview && (
            <p className="mt-6 leading-relaxed text-zinc-300">{series.overview}</p>
          )}
          {series.cast.length > 0 && (
            <div className="mt-6">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Cast</h3>
              <p className="mt-2 text-sm text-zinc-400">
                {series.cast
                  .slice(0, 6)
                  .map((c) => c.name)
                  .join(", ")}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-zinc-800 p-8">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h3 className="mr-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Seasons
          </h3>
          {seasons.map((s) => (
            <button
              key={s}
              onClick={() => setSeason(s)}
              className={`rounded-full px-3 py-1 text-sm transition ${
                s === season
                  ? "bg-zinc-100 text-black"
                  : "border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {eps.isPending && <p className="text-sm text-zinc-500">Loading episodes…</p>}
        {eps.isError && (
          <p className="text-sm text-red-400">{eps.error.message}</p>
        )}
        {eps.data && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {eps.data.episodes.map((e) => (
              <button
                key={e.imdbId}
                onClick={() => onPickEpisode(series, e)}
                className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-left hover:border-zinc-700 hover:bg-zinc-900"
              >
                <span className="mt-0.5 inline-block w-12 flex-shrink-0 text-center text-xs font-mono text-zinc-500">
                  S{e.season}E{String(e.episode).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-100">
                    {e.title}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {e.released ?? ""}
                    {e.rating > 0 && ` · ★ ${e.rating.toFixed(1)}`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
