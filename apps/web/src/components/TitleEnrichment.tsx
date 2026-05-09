import { useQuery } from "@tanstack/react-query";
import { api, type DiscoverTitle } from "../lib/api";

interface Props {
  imdbId: string;
  title: string;
  onPickSimilar: (t: { imdbId: string; type: "movie" | "series" }) => void;
}

/**
 * Renders "Available on:" badges + "More like this" row at the bottom of the
 * detail modal. Renders nothing while loading and nothing on hard miss — this
 * is decoration, not core content.
 */
export function TitleEnrichment({ imdbId, title, onPickSimilar }: Props) {
  const q = useQuery({
    queryKey: ["enrichment", imdbId],
    queryFn: () => api.discoverEnrichment(imdbId, title),
    staleTime: 1000 * 60 * 30,
  });

  if (q.isPending || q.isError || !q.data) return null;

  const { providers, similar } = q.data;
  if (providers.length === 0 && similar.length === 0) return null;

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 px-8 py-6">
      {providers.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Available on
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {providers.map((p) => (
              <span
                key={`${p.shortName}-${p.name}`}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  p.monetizationType === "FLATRATE"
                    ? "border border-emerald-700/40 bg-emerald-950/40 text-emerald-300"
                    : "border border-zinc-700 bg-zinc-900 text-zinc-300"
                }`}
                title={p.monetizationType.toLowerCase()}
              >
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {similar.length > 0 && (
        <div className={providers.length > 0 ? "mt-8" : ""}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            More like this
          </h3>
          <div className="-mx-2 mt-3 overflow-x-auto px-2 pb-2">
            <div className="flex gap-3">
              {similar.map((t) => (
                <SimilarCard key={t.jwId} title={t} onPick={onPickSimilar} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SimilarCard({
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
      title={clickable ? title.title : `${title.title} (no IMDb match)`}
      className={`group w-28 flex-shrink-0 text-left transition ${
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
      </div>
      <div className="mt-1.5 truncate text-[11px] font-medium text-zinc-200">
        {title.title}
      </div>
      <div className="text-[10px] text-zinc-500">{title.year ?? "—"}</div>
    </button>
  );
}
