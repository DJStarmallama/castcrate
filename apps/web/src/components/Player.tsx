import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MovieDetails } from "@castcrate/shared";
import { api, type StartTorrentResult, type SubtitleTrack } from "../lib/api";
import { formatBitsPerSec, formatPercent } from "../lib/format";
import { CastBar } from "./CastBar";
import { CastControls } from "./CastControls";
import { SubtitlePicker } from "./SubtitlePicker";
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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [subtitle, setSubtitle] = useState<SubtitleTrack | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const playUrl = smooth ? `${session.streamUrl}/transcoded` : session.streamUrl;

  const status = useQuery({
    queryKey: ["torrent-status", session.infoHash],
    queryFn: () => api.torrentStatus(session.infoHash),
    refetchInterval: 1500,
    enabled: !closing,
  });

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      const target = videoRef.current ?? containerRef.current;
      target?.requestFullscreen().catch(() => {});
    }
  }, []);

  // Track fullscreen state from document
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // 'F' shortcut toggles fullscreen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        if (!(e.target instanceof HTMLInputElement)) toggleFullscreen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggleFullscreen]);

  // Note: torrent removal happens explicitly in handleClose. We don't run
  // a cleanup-on-unmount effect because React StrictMode would fire it on
  // the very first render (mount → unmount → mount), killing the torrent
  // before it ever gets bytes.
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
    <div ref={containerRef} className="fixed inset-0 z-50 flex flex-col bg-black">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-900 bg-zinc-950 px-6 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium">{movie.title}</h2>
          <p className="truncate text-xs text-zinc-500">{session.videoName}</p>
        </div>
        {smooth && (
          <span
            className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300"
            title="Transcoding to MP4 H.264 capped at 5 Mbps"
          >
            Smooth
          </span>
        )}
        <SubtitlePicker
          infoHash={session.infoHash}
          selected={subtitle}
          onSelect={setSubtitle}
        />
        <CastBar
          streamPath={playUrl}
          title={movie.title}
          posterUrl={movie.poster}
          contentType={contentType}
          sessionId={castSessionId}
          onSessionChange={setCastSessionId}
          subtitle={subtitle}
          infoHash={session.infoHash}
        />
        {!isCasting && (
          <button
            onClick={toggleFullscreen}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            title={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
          >
            {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
        )}
        <button
          onClick={handleClose}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Stop & close
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center bg-black">
        {isCasting ? (
          <CastControls
            movie={movie}
            sessionId={castSessionId}
            onStop={() => setCastSessionId(null)}
            disableSeek={smooth}
          />
        ) : (
          <video
            ref={videoRef}
            // Force a fresh element when the subtitle track changes —
            // <video> caches text tracks aggressively otherwise.
            key={subtitle ? `${session.infoHash}-${subtitle.index}` : session.infoHash}
            src={playUrl}
            controls
            autoPlay
            crossOrigin="anonymous"
            className="h-full max-h-full w-full max-w-full"
          >
            {subtitle && (
              <track
                kind="subtitles"
                src={`/stream/${session.infoHash}/subtitles/${subtitle.index}`}
                label={subtitle.language}
                default
              />
            )}
          </video>
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

function FullscreenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
    </svg>
  );
}
function ExitFullscreenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
    </svg>
  );
}
