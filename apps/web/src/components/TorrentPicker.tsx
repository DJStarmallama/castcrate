import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MovieDetails, TorrentResult } from "@castcrate/shared";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";

interface Props {
  movie: MovieDetails;
  onClose: () => void;
  onPick: (torrent: TorrentResult) => void;
}

export function TorrentPicker({ movie, onClose, onPick }: Props) {
  const [showAll, setShowAll] = useState(false);

  const q = useQuery({
    queryKey: ["torrents", movie.title, movie.year],
    queryFn: () => api.searchTorrents(movie.title, movie.year ?? undefined),
  });

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

        <h2 className="text-xl font-semibold">Find sources</h2>
        <p className="text-sm text-zinc-500">
          {movie.title} {movie.year ? `(${movie.year})` : ""}
        </p>

        <div className="mt-6">
          {q.isPending && <p className="text-zinc-500">Searching torrents…</p>}
          {q.isError && (
            <div className="rounded-lg border border-red-700/40 bg-red-950/30 p-4 text-sm text-red-200">
              {q.error.message}
            </div>
          )}
          {q.data && q.data.results.length === 0 && (
            <p className="text-zinc-500">
              No compatible (1080p / 720p · x264) torrents found on YTS for this title.
            </p>
          )}
          {q.data && q.data.results.length > 0 && (
            <TorrentList
              results={q.data.results}
              showAll={showAll}
              onShowAll={() => setShowAll(true)}
              onPick={onPick}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TorrentList({
  results,
  showAll,
  onShowAll,
  onPick,
}: {
  results: TorrentResult[];
  showAll: boolean;
  onShowAll: () => void;
  onPick: (t: TorrentResult) => void;
}) {
  const top = results[0]!;
  const rest = results.slice(1);
  return (
    <div className="space-y-3">
      <TorrentRow torrent={top} highlight onPick={() => onPick(top)} />
      {!showAll && rest.length > 0 && (
        <button
          onClick={onShowAll}
          className="text-sm text-zinc-400 underline-offset-4 hover:text-zinc-200 hover:underline"
        >
          Show {rest.length} more option{rest.length === 1 ? "" : "s"}
        </button>
      )}
      {showAll && rest.map((t, i) => (
        <TorrentRow key={`${t.magnet}-${i}`} torrent={t} onPick={() => onPick(t)} />
      ))}
    </div>
  );
}

function TorrentRow({
  torrent,
  highlight,
  onPick,
}: {
  torrent: TorrentResult;
  highlight?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      className={`flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition ${
        highlight
          ? "border-emerald-700/40 bg-emerald-950/20 hover:border-emerald-500/60"
          : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-900"
      }`}
    >
      <div>
        <div className="font-medium">{torrent.resolution} · {torrent.videoCodec}</div>
        <div className="text-xs text-zinc-500">
          {formatBytes(torrent.sizeBytes)} · {torrent.seeds} seeds · {torrent.peers} peers
        </div>
      </div>
      <span
        className={`rounded-full px-3 py-1 text-xs font-medium ${
          highlight ? "bg-emerald-500 text-black" : "bg-zinc-800 text-zinc-300"
        }`}
      >
        Cast
      </span>
    </button>
  );
}
