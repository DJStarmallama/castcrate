import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { MovieDetails } from "@castcrate/shared";
import { api, type StartTorrentResult } from "../lib/api";
import { formatBitsPerSec, formatPercent } from "../lib/format";

interface Props {
  movie: MovieDetails;
  session: StartTorrentResult;
  onClose: () => void;
}

export function Player({ movie, session, onClose }: Props) {
  const [removed, setRemoved] = useState(false);

  const status = useQuery({
    queryKey: ["torrent-status", session.infoHash],
    queryFn: () => api.torrentStatus(session.infoHash),
    refetchInterval: 1500,
    enabled: !removed,
  });

  useEffect(() => {
    return () => {
      // best-effort cleanup
      if (!removed) {
        api.removeTorrent(session.infoHash).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = async () => {
    setRemoved(true);
    try {
      await api.removeTorrent(session.infoHash);
    } catch {
      /* ignore */
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <header className="flex items-center justify-between border-b border-zinc-900 bg-zinc-950 px-6 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-medium">{movie.title}</h2>
          <p className="truncate text-xs text-zinc-500">{session.videoName}</p>
        </div>
        <button
          onClick={handleClose}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Stop & close
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center bg-black">
        <video
          src={session.streamUrl}
          controls
          autoPlay
          className="h-full max-h-full w-full max-w-full"
        />
      </div>
      <footer className="border-t border-zinc-900 bg-zinc-950 px-6 py-3">
        {status.data ? (
          <ProgressBar
            progress={status.data.progress}
            speed={status.data.downloadSpeed}
            peers={status.data.numPeers}
            done={status.data.done}
          />
        ) : (
          <p className="text-xs text-zinc-500">Waiting for peers…</p>
        )}
      </footer>
    </div>
  );
}

function ProgressBar({
  progress,
  speed,
  peers,
  done,
}: {
  progress: number;
  speed: number;
  peers: number;
  done: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>
          {done ? "complete" : formatPercent(progress)} · {peers} peer{peers === 1 ? "" : "s"}
        </span>
        <span>{done ? "" : formatBitsPerSec(speed)}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-900">
        <div
          className={`h-full ${done ? "bg-emerald-500" : "bg-emerald-400"}`}
          style={{ width: `${Math.max(2, progress * 100)}%` }}
        />
      </div>
    </div>
  );
}
