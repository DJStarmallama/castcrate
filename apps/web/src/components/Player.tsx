import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { MovieDetails } from "@castcrate/shared";
import { api, type StartTorrentResult } from "../lib/api";
import { formatBitsPerSec, formatPercent } from "../lib/format";
import { CastBar } from "./CastBar";
import { useLocalState } from "../hooks/useLocalState";
import { SMOOTH_PLAYBACK_KEY } from "./Settings";

interface Props {
  movie: MovieDetails;
  session: StartTorrentResult;
  onClose: () => void;
}

export function Player({ movie, session, onClose }: Props) {
  const [castSessionId, setCastSessionId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [smooth] = useLocalState(SMOOTH_PLAYBACK_KEY, false);
  const playUrl = smooth ? `${session.streamUrl}/transcoded` : session.streamUrl;

  const status = useQuery({
    queryKey: ["torrent-status", session.infoHash],
    queryFn: () => api.torrentStatus(session.infoHash),
    refetchInterval: 1500,
    enabled: !closing,
  });

  useEffect(() => {
    return () => {
      if (!closing) {
        api.removeTorrent(session.infoHash).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = async () => {
    setClosing(true);
    try {
      if (castSessionId) {
        await api.castControl(castSessionId, "stop").catch(() => {});
      }
      await api.removeTorrent(session.infoHash).catch(() => {});
    } finally {
      onClose();
    }
  };

  const isCasting = castSessionId !== null;
  // Transcoded streams are always video/mp4. Native streams keep the source MIME.
  const contentType = smooth
    ? "video/mp4"
    : session.videoName.toLowerCase().endsWith(".mkv")
      ? "video/x-matroska"
      : "video/mp4";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-900 bg-zinc-950 px-6 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium">{movie.title}</h2>
          <p className="truncate text-xs text-zinc-500">{session.videoName}</p>
        </div>
        {smooth && (
          <span
            className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300"
            title={`Transcoding to MP4 H.264 capped at ${session.streamUrl ? "5 Mbps" : ""}`}
          >
            Smooth
          </span>
        )}
        <CastBar
          streamPath={playUrl}
          title={movie.title}
          posterUrl={movie.poster}
          contentType={contentType}
          sessionId={castSessionId}
          onSessionChange={setCastSessionId}
        />
        <button
          onClick={handleClose}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Stop & close
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center bg-black">
        {isCasting ? (
          <CastingPanel
            movie={movie}
            sessionId={castSessionId}
            onStop={() => setCastSessionId(null)}
          />
        ) : (
          <video
            src={playUrl}
            controls
            autoPlay
            className="h-full max-h-full w-full max-w-full"
          />
        )}
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

function CastingPanel({
  movie,
  sessionId,
  onStop,
}: {
  movie: MovieDetails;
  sessionId: string;
  onStop: () => void;
}) {
  const playPause = useMutation({
    mutationFn: (action: "play" | "pause") => api.castControl(sessionId, action),
  });
  const stop = useMutation({
    mutationFn: () => api.castControl(sessionId, "stop"),
    onSuccess: onStop,
  });
  const [isPaused, setIsPaused] = useState(false);

  return (
    <div className="flex max-w-xl flex-col items-center gap-6 p-12 text-center">
      {movie.poster && (
        <img
          src={movie.poster}
          alt={movie.title}
          className="h-64 rounded-lg shadow-2xl"
        />
      )}
      <div>
        <h3 className="text-2xl font-semibold">{movie.title}</h3>
        <p className="mt-2 text-zinc-400">Casting to Chromecast</p>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            const next = isPaused ? "play" : "pause";
            playPause.mutate(next, {
              onSuccess: () => setIsPaused(!isPaused),
            });
          }}
          className="rounded-full bg-zinc-800 px-6 py-3 hover:bg-zinc-700"
        >
          {isPaused ? "Play" : "Pause"}
        </button>
        <button
          onClick={() => stop.mutate()}
          className="rounded-full bg-red-500 px-6 py-3 text-black hover:bg-red-400"
        >
          Stop cast
        </button>
      </div>
    </div>
  );
}
