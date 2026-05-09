import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { MovieDetails } from "@castcrate/shared";
import { api } from "../lib/api";

interface Props {
  movie: MovieDetails;
  sessionId: string;
  onStop: () => void;
  /** v1 transcode streams aren't seekable — disable scrub when on. */
  disableSeek?: boolean;
}

export function CastControls({ movie, sessionId, onStop, disableSeek = false }: Props) {
  const session = useQuery({
    queryKey: ["cast-session", sessionId],
    queryFn: () => api.castSession(sessionId),
    // WebSocket bridge pushes cast:status events into this cache key.
    // Slow safety-net poll covers the case where the WS drops.
    refetchInterval: 10_000,
  });

  const ctrl = useMutation({
    mutationFn: ({
      action,
      value,
    }: {
      action: "play" | "pause" | "stop" | "seek" | "volume" | "mute" | "unmute";
      value?: number;
    }) => api.castControl(sessionId, action, value),
  });

  const stop = useMutation({
    mutationFn: () => api.castControl(sessionId, "stop"),
    onSuccess: onStop,
  });

  const data = session.data;
  const isPaused = data?.status === "paused";
  const isBuffering = data?.status === "buffering";
  const currentTime = data?.currentTime ?? 0;
  const duration = data?.duration ?? 0;
  const volumeLevel = data?.volumeLevel ?? 1;
  const muted = data?.muted ?? false;

  // Optimistic UI: render the user's drag immediately, then yield back to
  // server state when the next 1s poll catches up (or after 3s as a safety net).
  const [optimisticSeek, setOptimisticSeek] = useState<number | null>(null);
  const [optimisticVolume, setOptimisticVolume] = useState<number | null>(null);

  useEffect(() => {
    if (optimisticSeek === null) return;
    if (Math.abs(currentTime - optimisticSeek) < 2) setOptimisticSeek(null);
  }, [currentTime, optimisticSeek]);
  useEffect(() => {
    if (optimisticSeek === null) return;
    const t = setTimeout(() => setOptimisticSeek(null), 3000);
    return () => clearTimeout(t);
  }, [optimisticSeek]);

  useEffect(() => {
    if (optimisticVolume === null) return;
    if (Math.abs((muted ? 0 : volumeLevel) - optimisticVolume) < 0.05)
      setOptimisticVolume(null);
  }, [volumeLevel, muted, optimisticVolume]);
  useEffect(() => {
    if (optimisticVolume === null) return;
    const t = setTimeout(() => setOptimisticVolume(null), 3000);
    return () => clearTimeout(t);
  }, [optimisticVolume]);

  const displayTime = optimisticSeek ?? currentTime;
  const displayVolume = optimisticVolume ?? (muted ? 0 : volumeLevel);

  return (
    <div className="flex max-w-2xl flex-col items-center gap-6 p-12 text-center">
      {movie.poster && (
        <img
          src={movie.poster}
          alt={movie.title}
          className="h-56 rounded-lg shadow-2xl"
        />
      )}
      <div>
        <h3 className="text-2xl font-semibold">{movie.title}</h3>
        <p className="mt-2 text-sm text-zinc-400">
          {isBuffering ? "Buffering on Chromecast…" : "Casting to Chromecast"}
        </p>
      </div>

      {/* Seek bar */}
      <div className="w-full">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={1}
          value={Math.floor(displayTime)}
          onChange={(e) => {
            const v = Number(e.target.value);
            setOptimisticSeek(v);
            ctrl.mutate({ action: "seek", value: v });
          }}
          disabled={disableSeek || duration === 0}
          aria-label="Seek"
          className="w-full accent-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        />
        <div className="mt-1 flex justify-between text-xs text-zinc-500">
          <span>{formatTime(displayTime)}</span>
          <span>{disableSeek ? "seek disabled (transcoding)" : ""}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Transport row */}
      <div className="flex items-center gap-3">
        <IconButton
          onClick={() => {
            const v = Math.max(0, displayTime - 10);
            setOptimisticSeek(v);
            ctrl.mutate({ action: "seek", value: v });
          }}
          disabled={disableSeek}
          title="Skip back 10s"
        >
          <SkipBack />
        </IconButton>
        <button
          onClick={() => ctrl.mutate({ action: isPaused ? "play" : "pause" })}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-100 text-black hover:bg-white"
          aria-label={isPaused ? "Play" : "Pause"}
        >
          {isPaused ? <Play /> : <Pause />}
        </button>
        <IconButton
          onClick={() => {
            const v = Math.min(duration || displayTime + 10, displayTime + 10);
            setOptimisticSeek(v);
            ctrl.mutate({ action: "seek", value: v });
          }}
          disabled={disableSeek}
          title="Skip forward 10s"
        >
          <SkipForward />
        </IconButton>
      </div>

      {/* Volume row */}
      <div className="flex w-full max-w-sm items-center gap-3">
        <IconButton
          onClick={() => ctrl.mutate({ action: muted ? "unmute" : "mute" })}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? <VolumeMuted /> : volumeLevel > 0.5 ? <VolumeFull /> : <VolumeLow />}
        </IconButton>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={displayVolume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setOptimisticVolume(v);
            ctrl.mutate({ action: "volume", value: v });
          }}
          aria-label="Volume"
          className="flex-1 accent-emerald-500"
        />
      </div>

      <button
        onClick={() => stop.mutate()}
        className="mt-2 rounded-full bg-red-500 px-6 py-3 font-medium text-black hover:bg-red-400"
        disabled={stop.isPending}
      >
        {stop.isPending ? "Stopping…" : "Stop cast"}
      </button>
    </div>
  );
}

function IconButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const ICON: React.SVGProps<SVGSVGElement> = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "currentColor",
};

function Play() { return <svg {...ICON}><path d="M8 5v14l11-7z" /></svg>; }
function Pause() { return <svg {...ICON}><path d="M6 4h4v16H6zm8 0h4v16h-4z" /></svg>; }
function SkipBack() {
  return (
    <svg {...ICON}>
      <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z" />
    </svg>
  );
}
function SkipForward() {
  return (
    <svg {...ICON}>
      <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
    </svg>
  );
}
function VolumeFull() {
  return (
    <svg {...ICON}>
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06A7 7 0 0 1 14 18.7v2.06a9 9 0 0 0 0-17.54z" />
    </svg>
  );
}
function VolumeLow() {
  return (
    <svg {...ICON}>
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" />
    </svg>
  );
}
function VolumeMuted() {
  return (
    <svg {...ICON}>
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.59 3l3.7-3.71-1.41-1.41L15.17 10.59 11.46 6.88 10.05 8.29 13.76 12 10.05 15.71l1.41 1.41 3.71-3.71 3.71 3.71 1.41-1.41L16.59 12z" />
    </svg>
  );
}
