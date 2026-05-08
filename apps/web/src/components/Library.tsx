import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActiveTorrent, HistoryEntry } from "../lib/api";
import { api } from "../lib/api";
import { formatBitsPerSec, formatBytes, formatPercent } from "../lib/format";

interface Props {
  onClose: () => void;
}

export function Library({ onClose }: Props) {
  const qc = useQueryClient();
  const active = useQuery({
    queryKey: ["torrents-active"],
    queryFn: () => api.listTorrents(),
    refetchInterval: 2000,
  });
  const history = useQuery({
    queryKey: ["history"],
    queryFn: () => api.history(),
  });

  const removeOne = useMutation({
    mutationFn: (infoHash: string) => api.removeTorrent(infoHash),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["torrents-active"] });
      qc.invalidateQueries({ queryKey: ["history"] });
    },
  });

  const clearAll = useMutation({
    mutationFn: () => api.clearHistory(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["history"] }),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-12 w-full max-w-4xl rounded-2xl border border-zinc-800 bg-zinc-950 p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-2xl font-semibold">Library</h2>
          <button
            onClick={onClose}
            className="rounded-full bg-zinc-900 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <Section title="Active downloads">
          {active.isPending && <Empty>Loading…</Empty>}
          {active.data && active.data.torrents.length === 0 && <Empty>None</Empty>}
          {active.data?.torrents.map((t) => (
            <ActiveRow
              key={t.infoHash}
              torrent={t}
              onRemove={() => removeOne.mutate(t.infoHash)}
            />
          ))}
        </Section>

        <Section
          title="History"
          right={
            history.data && history.data.entries.length > 0 ? (
              <button
                onClick={() => clearAll.mutate()}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Clear all
              </button>
            ) : null
          }
        >
          {history.isPending && <Empty>Loading…</Empty>}
          {history.data && history.data.entries.length === 0 && (
            <Empty>Nothing yet — completed sessions will appear here.</Empty>
          )}
          {history.data?.entries.map((e) => <HistoryRow key={e.id} entry={e} />)}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
        {right}
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

function ActiveRow({
  torrent,
  onRemove,
}: {
  torrent: ActiveTorrent;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="h-14 w-10 flex-shrink-0 overflow-hidden rounded bg-zinc-900">
        {torrent.posterUrl && (
          <img src={torrent.posterUrl} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{torrent.title}</div>
        <div className="text-xs text-zinc-500">
          {torrent.done ? "complete" : formatPercent(torrent.progress)} ·{" "}
          {torrent.numPeers} peer{torrent.numPeers === 1 ? "" : "s"}
          {!torrent.done && ` · ${formatBitsPerSec(torrent.downloadSpeed)}`}
          {torrent.videoLength > 0 && ` · ${formatBytes(torrent.videoLength)}`}
        </div>
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className={torrent.done ? "h-full bg-emerald-500" : "h-full bg-emerald-400"}
            style={{ width: `${Math.max(2, torrent.progress * 100)}%` }}
          />
        </div>
      </div>
      <button
        onClick={onRemove}
        className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
      >
        Remove
      </button>
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const date = new Date(entry.endedAt);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-800/50 bg-zinc-900/30 p-3">
      <div className="h-14 w-10 flex-shrink-0 overflow-hidden rounded bg-zinc-900">
        {entry.posterUrl && (
          <img src={entry.posterUrl} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{entry.title}</div>
        <div className="text-xs text-zinc-500">
          {entry.resolution ?? "—"} · {date.toLocaleDateString()}{" "}
          {date.toLocaleTimeString()} · {entry.completed ? "completed" : "stopped"}
        </div>
      </div>
    </div>
  );
}
