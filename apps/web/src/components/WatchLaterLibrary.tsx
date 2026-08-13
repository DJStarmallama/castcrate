import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LibraryItem } from "@castcrate/shared";
import { api, type StartTorrentResult } from "../lib/api";
import { formatBitsPerSec, formatPercent } from "../lib/format";
import { useEscape } from "../hooks/useEscape";

interface Props {
  onClose: () => void;
  onPlay: (session: StartTorrentResult, meta: { title: string; poster: string | null }) => void;
}

export function WatchLaterLibrary({ onClose, onPlay }: Props) {
  useEscape(onClose);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const library = useQuery({
    queryKey: ["library"],
    queryFn: () => api.libraryList(),
    // 5s poll — matches the plan's cadence for live Downloading progress.
    refetchInterval: 5000,
  });

  const active = useQuery({
    queryKey: ["torrents-active"],
    queryFn: () => api.listTorrents(),
    refetchInterval: 5000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["library"] });
    qc.invalidateQueries({ queryKey: ["torrents-active"] });
  };

  const del = useMutation({
    mutationFn: (id: string) => api.libraryDelete(id),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  const pin = useMutation({
    mutationFn: (v: { id: string; pinned: boolean }) => api.librarySetPin(v.id, v.pinned),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  const play = useMutation({
    mutationFn: async (item: LibraryItem) => {
      const res = await api.libraryPlay(item.id);
      // The /:id/play route returns the stream URL + hash but does NOT re-attach
      // the torrent to the running WebTorrent client (backend Decision D3 —
      // route stays pure). We re-attach here via /api/torrent/start, which is
      // idempotent (duplicate-guard fast path in torrent.ts). Only needed when
      // item.magnet is present — TD .torrent-blob items don't have one; those
      // would need a different re-attach path (out of scope for v1).
      if (item.magnet) {
        await api
          .startTorrent({
            magnet: item.magnet,
            source: item.source,
            title: item.title,
            posterUrl: item.poster,
            imdbId: item.imdbId,
          })
          .catch(() => null);
      }
      // Fetch status so we can hand the Player a full StartTorrentResult
      // (it wants videoName + videoLength for the initial UI state).
      const status = await api.torrentStatus(res.hash).catch(() => null);
      const session: StartTorrentResult = {
        infoHash: res.hash,
        streamUrl: res.streamUrl,
        videoName: status?.name ?? item.title,
        videoLength: status?.videoLength ?? 0,
        videoCodec: null,
      };
      return { session, item };
    },
    onSuccess: ({ session, item }) => {
      onPlay(session, { title: item.title, poster: item.poster });
    },
    onError: (err: Error) => setError(err.message),
  });

  const confirmDelete = (item: LibraryItem) => {
    if (item.pinned) {
      setError("Unpin first — pinned items are protected from retention.");
      return;
    }
    if (!window.confirm(`Delete "${item.title}" from your Library? This removes the file from disk.`)) return;
    setError(null);
    del.mutate(item.id);
  };

  const cancelQueued = (item: LibraryItem) => {
    if (!window.confirm(`Remove "${item.title}" from the queue?`)) return;
    setError(null);
    del.mutate(item.id);
  };

  const activeByHash = new Map(
    (active.data?.torrents ?? []).map((t) => [t.infoHash, t] as const),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-12 w-full max-w-6xl rounded-2xl border border-zinc-800 bg-zinc-950 p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-semibold">Watch Later</h2>
            <p className="text-sm text-zinc-500">
              Background downloads. Pinned items survive the retention timer.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-zinc-900 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mt-4 flex items-center justify-between rounded-lg border border-red-700/40 bg-red-950/30 px-4 py-2 text-sm text-red-200">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-red-300 hover:text-red-100"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}

        <Section
          title="Queue"
          count={library.data?.queued.length ?? 0}
        >
          {library.isPending && <Empty>Loading…</Empty>}
          {library.data && library.data.queued.length === 0 && (
            <Empty>Nothing queued. Add titles from any search result.</Empty>
          )}
          {library.data?.queued.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              onCancel={() => cancelQueued(item)}
              busy={del.isPending && del.variables === item.id}
            />
          ))}
        </Section>

        <Section
          title="Downloading"
          count={library.data?.downloading.length ?? 0}
        >
          {library.data && library.data.downloading.length === 0 && (
            <Empty>Nothing downloading right now.</Empty>
          )}
          {library.data?.downloading.map((item) => (
            <DownloadingRow
              key={item.id}
              item={item}
              status={item.hash ? activeByHash.get(item.hash) ?? null : null}
              onCancel={() => cancelQueued(item)}
              busy={del.isPending && del.variables === item.id}
            />
          ))}
        </Section>

        <Section
          title="Completed"
          count={library.data?.completed.length ?? 0}
        >
          {library.data && library.data.completed.length === 0 && (
            <Empty>Nothing here yet — completed downloads will appear as posters.</Empty>
          )}
          {library.data && library.data.completed.length > 0 && (
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {library.data.completed.map((item) => (
                <CompletedCard
                  key={item.id}
                  item={item}
                  onPlay={() => play.mutate(item)}
                  onCast={() => play.mutate(item)}
                  onDelete={() => confirmDelete(item)}
                  onTogglePin={() =>
                    pin.mutate({ id: item.id, pinned: !item.pinned })
                  }
                  playing={play.isPending && play.variables?.id === item.id}
                />
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          {title}
        </h3>
        <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-xs text-zinc-400">
          {count}
        </span>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}

function Thumb({
  poster,
  alt,
  className = "h-14 w-10",
}: {
  poster: string | null;
  alt: string;
  className?: string;
}) {
  return (
    <div className={`${className} flex-shrink-0 overflow-hidden rounded bg-zinc-900`}>
      {poster && (
        <img src={poster} alt={alt} className="h-full w-full object-cover" />
      )}
    </div>
  );
}

function QueueRow({
  item,
  onCancel,
  busy,
}: {
  item: LibraryItem;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <Thumb poster={item.poster} alt={item.title} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.title}</div>
        <div className="text-xs text-zinc-500">
          {item.year ?? "—"} · queued · waiting for slot
        </div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label={`Remove ${item.title} from queue`}
        className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
      >
        {busy ? "…" : "Cancel"}
      </button>
    </div>
  );
}

function DownloadingRow({
  item,
  status,
  onCancel,
  busy,
}: {
  item: LibraryItem;
  status: { progress: number; downloadSpeed: number; numPeers: number } | null;
  onCancel: () => void;
  busy: boolean;
}) {
  const progress = status?.progress ?? 0;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <Thumb poster={item.poster} alt={item.title} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.title}</div>
        <div className="text-xs text-zinc-500">
          {status
            ? `${formatPercent(progress)} · ${status.numPeers} peer${status.numPeers === 1 ? "" : "s"} · ${formatBitsPerSec(status.downloadSpeed)}`
            : item.hash
              ? "connecting to peers…"
              : "resolving magnet…"}
        </div>
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full bg-emerald-400"
            style={{ width: `${Math.max(2, progress * 100)}%` }}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label={`Cancel download of ${item.title}`}
        className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
      >
        {busy ? "…" : "Cancel"}
      </button>
    </div>
  );
}

function CompletedCard({
  item,
  onPlay,
  onCast,
  onDelete,
  onTogglePin,
  playing,
}: {
  item: LibraryItem;
  onPlay: () => void;
  onCast: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  playing: boolean;
}) {
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-zinc-900">
        {item.poster ? (
          <img src={item.poster} alt={item.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            No poster
          </div>
        )}
        <button
          type="button"
          onClick={onTogglePin}
          aria-label={item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
          aria-pressed={item.pinned}
          title={item.pinned ? "Pinned — protected from retention" : "Pin to protect from retention"}
          className={`absolute right-2 top-2 rounded-full px-2 py-1 text-xs shadow-lg backdrop-blur-sm ${
            item.pinned
              ? "bg-amber-500/90 text-black"
              : "bg-black/60 text-zinc-200 hover:bg-black/80"
          }`}
        >
          {item.pinned ? "📌 Pinned" : "📌 Pin"}
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{item.title}</div>
          <div className="text-xs text-zinc-500">{item.year ?? "—"}</div>
        </div>
        <div className="mt-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onPlay}
            disabled={playing}
            className="flex-1 rounded-full bg-emerald-500 px-3 py-1 text-xs font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
          >
            {playing ? "Opening…" : "Play"}
          </button>
          <button
            type="button"
            onClick={onCast}
            disabled={playing}
            className="flex-1 rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            Cast
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${item.title}`}
            className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-red-500/90 hover:text-black"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
