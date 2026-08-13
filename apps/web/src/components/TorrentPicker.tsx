import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MovieDetails, TorrentResult } from "@castcrate/shared";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { useEscape } from "../hooks/useEscape";
import { useLocalState } from "../hooks/useLocalState";

const INSTANT_ONLY_KEY = "castcrate.instantOnly";

interface Props {
  movie: MovieDetails;
  onClose: () => void;
  onPick: (torrent: TorrentResult) => void;
}

export function TorrentPicker({ movie, onClose, onPick }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [instantOnly, setInstantOnly] = useLocalState(INSTANT_ONLY_KEY, false);
  const [toast, setToast] = useState<string | null>(null);
  const qc = useQueryClient();
  useEscape(onClose);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const addToQueue = useMutation({
    mutationFn: (t: TorrentResult) =>
      api.libraryAdd({
        magnet: t.magnet,
        metadata: {
          title: movie.title,
          year: movie.year,
          poster: movie.poster,
          imdbId: movie.imdbId,
          source: t.source,
        },
      }),
    onSuccess: (res) => {
      setToast(res.alreadyPresent ? "Already in Library" : "Added to Watch Later");
      qc.invalidateQueries({ queryKey: ["library"] });
    },
    onError: (err: Error) => setToast(`Failed: ${err.message}`),
  });

  const q = useQuery({
    queryKey: ["torrents", movie.title, movie.year, movie.imdbId],
    queryFn: () =>
      api.searchTorrents(movie.title, movie.year ?? undefined, movie.imdbId),
  });

  const filteredResults = q.data
    ? instantOnly
      ? q.data.results.filter((r) => Boolean(r.streamUrl))
      : q.data.results
    : [];
  const instantCount = q.data?.results.filter((r) => Boolean(r.streamUrl)).length ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full bg-zinc-900/80 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Close"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Find sources</h2>
            <p className="text-sm text-zinc-500">
              {movie.title} {movie.year ? `(${movie.year})` : ""}
            </p>
          </div>
          <label
            className="flex shrink-0 cursor-pointer items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/50 px-3 py-1.5 text-xs text-zinc-300 hover:border-amber-500/40"
            title="Show only Real-Debrid cached results that play instantly"
          >
            <input
              type="checkbox"
              checked={instantOnly}
              onChange={(e) => setInstantOnly(e.target.checked)}
              className="accent-amber-400"
            />
            <span>⚡ Instant only</span>
          </label>
        </div>

        <div className="mt-6">
          {q.isPending && <p className="text-zinc-500">Searching torrents…</p>}
          {q.isError && (
            <div className="rounded-lg border border-red-700/40 bg-red-950/30 p-4 text-sm text-red-200">
              {q.error.message}
            </div>
          )}
          {q.data && q.data.results.length === 0 && (
            <p className="text-zinc-500">
              No compatible (1080p / 720p · x264) torrents found
              {q.data.tried && q.data.tried.length > 0
                ? ` in ${q.data.tried.join(", ")}`
                : ""}
              {" "}for this title.
            </p>
          )}
          {q.data && q.data.results.length > 0 && filteredResults.length === 0 && instantOnly && (
            <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 p-4 text-sm text-amber-200">
              No ⚡ Instant streams for this title. {q.data.results.length} torrent
              {q.data.results.length === 1 ? "" : "s"} hidden by the filter — uncheck "Instant only" to see them.
            </div>
          )}
          {filteredResults.length > 0 && (
            <>
              {instantOnly && (
                <p className="mb-3 text-xs text-amber-400/80">
                  Showing {instantCount} instant result{instantCount === 1 ? "" : "s"}.
                  Filter is on — uncheck "Instant only" to see torrent magnets too.
                </p>
              )}
              <TorrentList
                results={filteredResults}
                showAll={showAll}
                onShowAll={() => setShowAll(true)}
                onPick={onPick}
                onQueue={(t) => addToQueue.mutate(t)}
                queuingMagnet={addToQueue.isPending ? addToQueue.variables?.magnet ?? null : null}
              />
            </>
          )}
        </div>
        {toast && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900/95 px-4 py-2 text-xs text-zinc-100 shadow-lg"
          >
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function TorrentList({
  results,
  showAll,
  onShowAll,
  onPick,
  onQueue,
  queuingMagnet,
}: {
  results: TorrentResult[];
  showAll: boolean;
  onShowAll: () => void;
  onPick: (t: TorrentResult) => void;
  onQueue: (t: TorrentResult) => void;
  queuingMagnet: string | null;
}) {
  const top = results[0]!;
  const rest = results.slice(1);
  return (
    <div className="space-y-3">
      <TorrentRow
        torrent={top}
        highlight
        onPick={() => onPick(top)}
        onQueue={() => onQueue(top)}
        queuing={queuingMagnet === top.magnet}
      />
      {!showAll && rest.length > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="text-sm text-zinc-400 underline-offset-4 hover:text-zinc-200 hover:underline"
        >
          Show {rest.length} more option{rest.length === 1 ? "" : "s"}
        </button>
      )}
      {showAll && rest.map((t, i) => (
        <TorrentRow
          key={`${t.magnet}-${i}`}
          torrent={t}
          onPick={() => onPick(t)}
          onQueue={() => onQueue(t)}
          queuing={queuingMagnet === t.magnet}
        />
      ))}
    </div>
  );
}

function TorrentRow({
  torrent,
  highlight,
  onPick,
  onQueue,
  queuing,
}: {
  torrent: TorrentResult;
  highlight?: boolean;
  onPick: () => void;
  onQueue: () => void;
  queuing: boolean;
}) {
  const isStremio = torrent.source === "stremio";
  const isInstant = isStremio && Boolean(torrent.streamUrl);
  const sizeText = torrent.sizeBytes > 0 ? formatBytes(torrent.sizeBytes) : "size unknown";
  const swarmText = isStremio
    ? `via ${torrent.addonOrigin ?? "Stremio"} · seeds unknown`
    : `${torrent.seeds} seeds · ${torrent.peers} peers`;
  // v1: Watch Later requires a magnet. TorrentDay uses a .torrent blob;
  // Stremio HTTP streams have no magnet either. Disable with tooltip.
  const canQueue = Boolean(torrent.magnet) && torrent.source !== "torrentday" && !torrent.streamUrl;
  const queueTitle = canQueue
    ? "Download in the background; play from disk later"
    : torrent.source === "torrentday"
      ? "TorrentDay results aren't supported yet (no magnet URI)"
      : torrent.streamUrl
        ? "Instant streams can't be added to Watch Later"
        : "This source has no magnet URI";
  return (
    <div
      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition ${
        isInstant
          ? "border-amber-500/40 bg-amber-950/10 hover:border-amber-400/60"
          : highlight
            ? "border-emerald-700/40 bg-emerald-950/20 hover:border-emerald-500/60"
            : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-900"
      }`}
    >
      <button
        type="button"
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center justify-between text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{torrent.resolution} · {torrent.videoCodec}</span>
            {isInstant && (
              <span
                className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300"
                title="Real-Debrid cached — plays instantly, no peer wait"
              >
                ⚡ Instant
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500">
            {sizeText} · {swarmText}
          </div>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onQueue}
          disabled={!canQueue || queuing}
          title={queueTitle}
          aria-label="Add to Watch Later"
          className="rounded-full border border-zinc-700 bg-zinc-900/80 px-3 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {queuing ? "Adding…" : "+ Watch Later"}
        </button>
        <button
          type="button"
          onClick={onPick}
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            isInstant
              ? "bg-amber-500 text-black"
              : highlight
                ? "bg-emerald-500 text-black"
                : "bg-zinc-800 text-zinc-300"
          }`}
        >
          Cast
        </button>
      </div>
    </div>
  );
}
