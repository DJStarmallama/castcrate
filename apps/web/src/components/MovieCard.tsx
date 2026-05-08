import type { MovieSearchResult } from "@castcrate/shared";

interface Props {
  movie: MovieSearchResult;
  onClick: () => void;
}

export function MovieCard({ movie, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col text-left transition hover:scale-[1.02]"
    >
      <div className="aspect-[2/3] w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        {movie.poster ? (
          <img
            src={movie.poster}
            alt={movie.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-950 text-3xl font-semibold text-zinc-600">
            {movie.title.charAt(0)}
          </div>
        )}
      </div>
      <div className="mt-2">
        <h3 className="line-clamp-2 text-sm font-medium text-zinc-100">{movie.title}</h3>
        <p className="text-xs text-zinc-500">
          {movie.year ?? "—"} · ★ {movie.rating.toFixed(1)}
        </p>
      </div>
    </button>
  );
}
