import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { MovieDetails } from "@castcrate/shared";
import { api, type StartTorrentResult, type SubtitleTrack } from "../lib/api";
import { formatBitsPerSec, formatPercent } from "../lib/format";
import { CastControls } from "./CastControls";
import { PlayerControls, type PlayerControlsHandle } from "./PlayerControls";
import { useLocalState } from "../hooks/useLocalState";
import { useAutoHide } from "../hooks/useAutoHide";
import {
  DEAD_SWARM_THRESHOLD_MS,
  isBufferingState,
  isInitialState,
  isStalledState,
  useBufferState,
  type BufferState,
} from "../hooks/useBufferState";
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

  // Force the PlayerControls-facing "video" prop to re-render when the
  // <video> element actually mounts (the ref alone won't trigger it).
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideoEl(el);
  }, []);

  // HTTP-stream sessions (Stremio debrid) have infoHash === null.
  // Torrent-based sessions always have a non-null infoHash.
  const isHttpStream = session.infoHash === null;

  // Auto-transcode for codecs the Default Media Receiver can't play directly
  // (HEVC, AV1). The user toggle still wins over this — but if they haven't
  // explicitly opted in, we route HEVC/AV1 through ffmpeg so playback Just Works.
  // HTTP-stream sessions are never transcoded (no webtorrent readable; ffmpeg
  // URL-input pipeline is a future enhancement).
  const autoTranscode = !isHttpStream && needsAutoTranscode(session.videoCodec);
  const useTranscode = !isHttpStream && (smooth || autoTranscode);
  // For local torrent streams, append /transcoded when needed. For absolute
  // HTTP URLs (debrid), use the URL verbatim — appending a path suffix would
  // produce a nonsense URL pointing at the CDN.
  const playUrl = useTranscode ? `${session.streamUrl}/transcoded` : session.streamUrl;

  // Explicit buffering state machine — see `hooks/useBufferState.ts`. HTTP
  // streams never dispatch, so the state sits at its initial value and the
  // render site's `isHttpStream` guard suppresses the overlay.
  const { state: bufferState, dispatch: dispatchBuffer } = useBufferState();

  const status = useQuery({
    queryKey: ["torrent-status", session.infoHash],
    // infoHash is non-null for torrent sessions; query is disabled for HTTP streams.
    queryFn: () => api.torrentStatus(session.infoHash!),
    refetchInterval: (q) => {
      if (q.state.data?.done) return false;
      // Fast polling while in any buffering-flavored state so the buffer %
      // updates feel live; slower once playback is stable.
      if (isBufferingState(bufferState)) return 1500;
      return 10_000;
    },
    enabled: !closing && !isHttpStream,
  });

  // Multi-file torrents (season packs etc.): let the user pick which file
  // is streamed. The server keeps the chosen index in TorrentMeta and the
  // /stream/:hash endpoint resolves through that.
  // Not applicable for HTTP-stream sessions.
  const filesQ = useQuery({
    queryKey: ["torrent-files", session.infoHash],
    queryFn: () => api.torrentFiles(session.infoHash!),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: !closing && !isHttpStream,
  });
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null);
  useEffect(() => {
    if (selectedFileIndex !== null || !filesQ.data) return;
    setSelectedFileIndex(
      filesQ.data.selectedIndex ?? filesQ.data.files[0]?.index ?? null,
    );
  }, [filesQ.data, selectedFileIndex]);
  const selectFile = useMutation({
    mutationFn: (index: number) => api.selectTorrentFile(session.infoHash!, index),
    onSuccess: (_data, index) => setSelectedFileIndex(index),
  });
  const files = filesQ.data?.files ?? [];
  const showFilePicker = files.length > 1;

  // Detect a stalled stream — progress hasn't budged in
  // DEAD_SWARM_THRESHOLD_MS while still downloading. Feeds the buffer state
  // machine so the overlay switches to "Waiting for peers…". Fires on every
  // poll while the condition holds so the state machine has fresh context
  // if the video later drops back into `buffering` (a stall latched while
  // in `playing` is a no-op, but a stall still in effect when `waiting`
  // arrives should immediately move us to `stalled` not `buffering`).
  const lastProgressRef = useRef<{ value: number; time: number }>({
    value: 0,
    time: Date.now(),
  });
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const data = status.data;
    if (!data) return;
    const now = Date.now();
    if (data.progress !== lastProgressRef.current.value) {
      lastProgressRef.current = { value: data.progress, time: now };
      if (stalled) setStalled(false);
      dispatchBuffer({ type: "recovered" });
    } else if (
      !data.done &&
      now - lastProgressRef.current.time > DEAD_SWARM_THRESHOLD_MS
    ) {
      if (!stalled) setStalled(true);
      dispatchBuffer({
        type: "stall_detected",
        sinceMs: now - lastProgressRef.current.time,
      });
    }
  }, [status.data, stalled, dispatchBuffer]);

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

  // Bridge the <video> element's readiness events into the buffer state
  // machine. `canplay` is preferred as the overlay-dismiss trigger because
  // Chrome's autoplay policy can suppress `playing` until the user clicks —
  // and the overlay covers the click area, so relying on `playing` alone
  // left the overlay stuck (fixed as part of Phase 6).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onCanPlay = () => dispatchBuffer({ type: "buffered" });
    const onPlaying = () => dispatchBuffer({ type: "playing" });
    const onWaiting = () => dispatchBuffer({ type: "waiting" });
    v.addEventListener("playing", onPlaying);
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("waiting", onWaiting);
    return () => {
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("waiting", onWaiting);
    };
  }, [playUrl, dispatchBuffer, videoEl]);

  // ---- auto-hide bar + shortcuts state ----

  // Bar visibility: track whether the video element is playing (so we know
  // whether to arm the hide timer) and whether any menu/scrub/buffer is
  // keeping the bar open.
  const [isPlaying, setIsPlaying] = useState(false);
  const [subtitleOpen, setSubtitleOpen] = useState(false);
  const [castOpen, setCastOpen] = useState(false);

  // Bar stays open while any popover is open OR while buffering (so the
  // user can bail out of a stuck stream mid-buffer).
  const keepBarOpen = subtitleOpen || castOpen || isBufferingState(bufferState);

  const autoHide = useAutoHide({
    isPlaying,
    keepOpen: keepBarOpen,
  });

  // Track play/pause via the video element for auto-hide invariants.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    // Seed the flag in case play() ran before we attached.
    setIsPlaying(!v.paused);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [videoEl]);

  // Container-level mousemove: any activity reveals the bar and re-arms
  // the hide timer.
  const onContainerMouseMove = useCallback(() => {
    autoHide.showNow();
  }, [autoHide]);

  // Handle for the "C" shortcut → open subtitle menu imperatively.
  const controlsHandleRef = useRef<PlayerControlsHandle | null>(null);

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(document.activeElement)) return;
      const v = videoRef.current;
      // Some shortcuts (Space, arrows) don't need the video element yet — the
      // fullscreen shortcut still works pre-video. Guard per branch.
      const showBar = () => autoHide.showNow();
      switch (e.key) {
        case " ":
        case "Spacebar": // legacy IE/Edge
          if (e.repeat) return;
          e.preventDefault();
          if (v) {
            if (v.paused) void v.play().catch(() => {});
            else v.pause();
          }
          showBar();
          return;
        case "ArrowLeft": {
          if (!v) return;
          e.preventDefault();
          const step = e.shiftKey ? 30 : 10;
          v.currentTime = Math.max(0, v.currentTime - step);
          showBar();
          return;
        }
        case "ArrowRight": {
          if (!v) return;
          e.preventDefault();
          const step = e.shiftKey ? 30 : 10;
          const max = Number.isFinite(v.duration) ? v.duration : v.currentTime + step;
          v.currentTime = Math.min(max, v.currentTime + step);
          showBar();
          return;
        }
        case "ArrowUp": {
          if (!v) return;
          e.preventDefault();
          v.volume = Math.min(1, v.volume + 0.05);
          if (v.muted && v.volume > 0) v.muted = false;
          showBar();
          return;
        }
        case "ArrowDown": {
          if (!v) return;
          e.preventDefault();
          v.volume = Math.max(0, v.volume - 0.05);
          showBar();
          return;
        }
        case "m":
        case "M":
          if (!v) return;
          e.preventDefault();
          v.muted = !v.muted;
          showBar();
          return;
        case "c":
        case "C":
          e.preventDefault();
          controlsHandleRef.current?.openSubtitleMenu();
          showBar();
          return;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          showBar();
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autoHide, toggleFullscreen]);

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
      // HTTP-stream sessions (infoHash === null) have no webtorrent entry to remove.
      if (session.infoHash) {
        await api.removeTorrent(session.infoHash).catch(() => {});
      }
    } finally {
      onClose();
    }
  };

  const isCasting = castSessionId !== null;
  // Transcoded streams are always video/mp4. Native streams keep the source MIME.
  const contentType = useTranscode
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
        {useTranscode && (
          <span
            className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300"
            title={
              autoTranscode && !smooth
                ? `Auto-transcoding because source codec is ${session.videoCodec ?? "unsupported"}`
                : "Transcoding to MP4 H.264 capped at 5 Mbps"
            }
          >
            {autoTranscode && !smooth ? "Auto" : "Smooth"}
          </span>
        )}
        {showFilePicker && (
          <select
            value={selectedFileIndex ?? ""}
            onChange={(e) => selectFile.mutate(Number(e.target.value))}
            disabled={selectFile.isPending}
            title="Choose which file in this torrent to play"
            className="max-w-xs truncate rounded-full bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {files.map((f) => (
              <option key={f.index} value={f.index}>
                {f.name}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={handleClose}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Stop & close
        </button>
      </header>
      <div
        className={`relative flex flex-1 items-center justify-center bg-black ${
          !isCasting && !autoHide.visible ? "cursor-none" : ""
        }`}
        onMouseMove={isCasting ? undefined : onContainerMouseMove}
      >
        {isCasting ? (
          <CastControls
            movie={movie}
            sessionId={castSessionId}
            onStop={() => setCastSessionId(null)}
            disableSeek={useTranscode}
          />
        ) : (
          <>
            <video
              ref={setVideoRef}
              // Force a fresh element when the subtitle track or selected
              // video file changes — <video> caches text tracks aggressively
              // and won't re-fetch a new src on its own.
              key={`${session.infoHash ?? "http"}-${selectedFileIndex ?? "auto"}-${subtitle?.index ?? "none"}`}
              src={playUrl}
              autoPlay
              crossOrigin="anonymous"
              onDoubleClick={toggleFullscreen}
              onClick={() => {
                // Click on the video (not on the bar) toggles play/pause,
                // matching YouTube. Double-click still fires as well; the
                // browser dispatches click before dblclick — we tolerate the
                // extra pause-then-resume in the very rare double-click case
                // (matches Chrome's native controls' own behavior).
                const v = videoRef.current;
                if (!v) return;
                if (v.paused) void v.play().catch(() => {});
                else v.pause();
              }}
              className="h-full max-h-full w-full max-w-full"
            >
              {subtitle && session.infoHash && (
                <track
                  kind="subtitles"
                  src={`/stream/${session.infoHash}/subtitles/${subtitle.index}`}
                  label={subtitle.language}
                  default
                />
              )}
            </video>
            {!isHttpStream && isBufferingState(bufferState) && status.data && !status.data.done && (
              <BufferingOverlay
                progress={status.data.progress}
                speed={status.data.downloadSpeed}
                peers={status.data.numPeers}
                state={bufferState}
              />
            )}
            <PlayerControls
              videoRef={videoRef}
              videoElement={videoEl}
              visible={autoHide.visible}
              onMouseEnter={autoHide.cancelHide}
              onMouseLeave={autoHide.scheduleHide}
              title={movie.title}
              subtitleContext={session.videoName}
              infoHash={session.infoHash}
              subtitle={subtitle}
              onSubtitleChange={setSubtitle}
              castSessionId={castSessionId}
              onCastSessionChange={setCastSessionId}
              streamPath={playUrl}
              posterUrl={movie.poster}
              contentType={contentType}
              stremioHttpStream={isHttpStream}
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
              onSubtitleOpenChange={setSubtitleOpen}
              onCastOpenChange={setCastOpen}
              handleRef={controlsHandleRef}
            />
          </>
        )}
      </div>
      <footer className="border-t border-zinc-900 bg-zinc-950 px-6 py-3">
        {isHttpStream ? (
          <p className="text-xs text-zinc-500">
            Direct stream via Stremio addon — no download progress to show.
          </p>
        ) : status.data ? (
          <ProgressBar
            progress={status.data.progress}
            speed={status.data.downloadSpeed}
            peers={status.data.numPeers}
            done={status.data.done}
            stalled={stalled}
          />
        ) : (
          <p className="text-xs text-zinc-500">Waiting for peers…</p>
        )}
      </footer>
    </div>
  );
}

/**
 * True when the currently-focused element is a form input we should not
 * hijack keyboard shortcuts from. Also excludes contentEditable elements
 * for good measure (Radix Popover trigger buttons don't set contentEditable,
 * so they don't false-positive here).
 */
function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

function ProgressBar({
  progress,
  speed,
  peers,
  done,
  stalled,
}: {
  progress: number;
  speed: number;
  peers: number;
  done: boolean;
  stalled: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className={stalled ? "text-amber-400" : "text-zinc-500"}>
          {done
            ? "complete"
            : stalled
              ? `stalled — no bytes received (${peers} peer${peers === 1 ? "" : "s"})`
              : `${formatPercent(progress)} · ${peers} peer${peers === 1 ? "" : "s"}`}
        </span>
        <span className="text-zinc-500">{done ? "" : formatBitsPerSec(speed)}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-900">
        <div
          className={`h-full ${
            done ? "bg-emerald-500" : stalled ? "bg-amber-500" : "bg-emerald-400"
          }`}
          style={{ width: `${Math.max(2, progress * 100)}%` }}
        />
      </div>
    </div>
  );
}

function BufferingOverlay({
  progress,
  speed,
  peers,
  state,
}: {
  progress: number;
  speed: number;
  peers: number;
  state: BufferState;
}) {
  const stalled = isStalledState(state);
  const initial = isInitialState(state);
  const pct = Math.round(progress * 100 * 10) / 10;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="pointer-events-auto flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/90 p-6 text-center shadow-2xl">
        <div className="flex items-center gap-3">
          {!stalled && (
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" />
          )}
          <span className="text-base font-medium">
            {stalled
              ? "Waiting for peers…"
              : initial
                ? "Buffering…"
                : "Buffering — waiting for more data"}
          </span>
        </div>
        <div className="w-full">
          <div className="flex justify-between text-xs text-zinc-400">
            <span>{pct}% downloaded</span>
            <span>{formatBitsPerSec(speed)}</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-900">
            <div
              className={`h-full ${stalled ? "bg-amber-500" : "bg-emerald-400"}`}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          {peers === 0
            ? "No peers connected yet — this can take a moment for older releases."
            : `Connected to ${peers} peer${peers === 1 ? "" : "s"}.`}
        </p>
      </div>
    </div>
  );
}

// Codecs the Chromecast Default Media Receiver can't play directly. When we
// detect one, route through the ffmpeg transcoder pipeline by default.
function needsAutoTranscode(codec: string | null | undefined): boolean {
  if (!codec) return false;
  const c = codec.toLowerCase();
  return c === "x265" || c === "h265" || c === "hevc" || c === "av1";
}
