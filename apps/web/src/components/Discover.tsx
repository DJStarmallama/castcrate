import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type DiscoverGenre, type DiscoverTitle } from "../lib/api";

interface Props {
  /**
   * The detail modal flow needs an IMDb ID. JustWatch returns one for most
   * titles, but newer/obscure ones may have it null — we hide the click on
   * those (poster still shows, just not interactive).
   */
  onPickTitle: (title: { imdbId: string; type: "movie" | "series" }) => void;
}

export function Discover({ onPickTitle }: Props) {
  const [genre, setGenre] = useState<string | null>(null);

  const providersQ = useQuery({
    queryKey: ["discover-providers"],
    queryFn: () => api.discoverProviders(),
    staleTime: Infinity,
  });
  const genresQ = useQuery({
    queryKey: ["discover-genres"],
    queryFn: () => api.discoverGenres(),
    staleTime: 1000 * 60 * 60 * 24,
  });

  const providers = providersQ.data?.providers ?? [];
  const genres = genresQ.data?.genres ?? [];

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Discover</h2>
          <p className="mt-1 text-sm text-zinc-500">
            What's trending in Australia. Pick a genre to filter every row.
          </p>
        </div>
      </div>

      <GenreBar
        genres={genres}
        selected={genre}
        onSelect={setGenre}
      />

      <div className="mt-8 space-y-10">
        <Row
          title={genre ? `Trending — ${genres.find((g) => g.shortName === genre)?.name}` : "Trending this week"}
          queryKey={["discover-popular", { genre }]}
          fetch={() => api.discoverPopular({ genre: genre ?? undefined })}
          onPickTitle={onPickTitle}
        />
        {providers.map((p) => (
          <Row
            key={p.id}
            title={`Popular on ${p.name}`}
            queryKey={["discover-popular", { provider: p.id, genre }]}
            fetch={() =>
              api.discoverPopular({
                provider: p.id,
                genre: genre ?? undefined,
              })
            }
            onPickTitle={onPickTitle}
          />
        ))}
      </div>
    </div>
  );
}

function GenreBar({
  genres,
  selected,
  onSelect,
}: {
  genres: DiscoverGenre[];
  selected: string | null;
  onSelect: (g: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Pill active={selected === null} onClick={() => onSelect(null)}>
        All
      </Pill>
      {genres.map((g) => (
        <Pill
          key={g.shortName}
          active={selected === g.shortName}
          onClick={() => onSelect(selected === g.shortName ? null : g.shortName)}
        >
          {g.name}
        </Pill>
      ))}
    </div>
  );
}

function Pill({
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
      className={`rounded-full px-3 py-1 text-sm transition ${
        active
          ? "bg-amber-500 text-black"
          : "border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

function Row({
  title,
  queryKey,
  fetch,
  onPickTitle,
}: {
  title: string;
  queryKey: unknown[];
  fetch: () => Promise<{ titles: DiscoverTitle[] }>;
  onPickTitle: (t: { imdbId: string; type: "movie" | "series" }) => void;
}) {
  const q = useQuery({
    queryKey,
    queryFn: fetch,
    staleTime: 1000 * 60 * 30,
  });

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        {title}
      </h3>
      {q.isPending && (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="aspect-[2/3] w-32 flex-shrink-0 animate-pulse rounded-lg bg-zinc-900"
            />
          ))}
        </div>
      )}
      {q.isError && (
        <p className="text-xs text-red-400">{q.error.message}</p>
      )}
      {q.data && q.data.titles.length === 0 && (
        <p className="text-xs text-zinc-500">No titles for this filter.</p>
      )}
      {q.data && q.data.titles.length > 0 && (
        <div className="-mx-6 overflow-x-auto px-6 pb-3">
          <div className="flex gap-3">
            {q.data.titles.map((t) => (
              <PosterCard key={t.jwId} title={t} onPick={onPickTitle} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function PosterCard({
  title,
  onPick,
}: {
  title: DiscoverTitle;
  onPick: (t: { imdbId: string; type: "movie" | "series" }) => void;
}) {
  const clickable = title.imdbId !== null;
  return (
    <button
      onClick={() => {
        if (title.imdbId) onPick({ imdbId: title.imdbId, type: title.type });
      }}
      disabled={!clickable}
      title={clickable ? title.title : `${title.title} (no IMDb match — can't load detail)`}
      className={`group relative w-32 flex-shrink-0 text-left transition ${
        clickable ? "cursor-pointer" : "cursor-not-allowed opacity-40"
      }`}
    >
      <div className="aspect-[2/3] w-full overflow-hidden rounded-lg bg-zinc-900">
        {title.poster ? (
          <img
            src={title.poster}
            alt={title.title}
            loading="lazy"
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-2xl text-zinc-700">
            {title.title.charAt(0)}
          </div>
        )}
        {title.type === "series" && (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-indigo-500/90 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white">
            TV
          </span>
        )}
      </div>
      <div className="mt-2 truncate text-xs font-medium text-zinc-200">
        {title.title}
      </div>
      <div className="text-[10px] text-zinc-500">
        {title.year ?? "—"}
        {title.rating > 0 && ` · ★ ${title.rating.toFixed(1)}`}
      </div>
    </button>
  );
}
