import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { MovieDetails } from "@castcrate/shared";
import { api, type StartTorrentResult, type SubtitleTrack } from "../lib/api";
import { formatBitsPerSec, formatPercent } from "../lib/format";
import { CastBar } from "./CastBar";
import { CastControls } from "./CastControls";
import { SubtitlePicker } from "./SubtitlePicker";
import { useLocalState } from "../hooks/useLocalState";
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
  }, [playUrl, dispatchBuffer]);

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
        {/* SubtitlePicker only applies to torrent sessions with a known infoHash.
            castSessionId is forwarded so the picker can hot-swap the receiver
            track via EDIT_TRACKS_INFO while a cast is active. `imdbId` enables
            the OpenSubtitles fallback branch on the server so releases with
            no embedded .srt/.vtt (e.g. YTS) still get a subtitle list. */}
        {session.infoHash && (
          <SubtitlePicker
            infoHash={session.infoHash}
            imdbId={movie.imdbId}
            selected={subtitle}
            onSelect={setSubtitle}
            castSessionId={castSessionId}
          />
        )}
        <CastBar
          streamPath={playUrl}
          title={movie.title}
          posterUrl={movie.poster}
          contentType={contentType}
          sessionId={castSessionId}
          onSessionChange={setCastSessionId}
          subtitle={subtitle}
          infoHash={session.infoHash ?? undefined}
          imdbId={movie.imdbId}
          stremioHttpStream={isHttpStream}
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
      <div className="relative flex flex-1 items-center justify-center bg-black">
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
              ref={videoRef}
              // Force a fresh element when the subtitle track or selected
              // video file changes — <video> caches text tracks aggressively
              // and won't re-fetch a new src on its own. The subtitle key
              // uses a source-tagged identifier so torrent-index N and
              // opensubtitles-index N produce distinct keys.
              key={`${session.infoHash ?? "http"}-${selectedFileIndex ?? "auto"}-${subtitleKey(subtitle)}`}
              src={playUrl}
              controls
              autoPlay
              crossOrigin="anonymous"
              className="h-full max-h-full w-full max-w-full"
            >
              {subtitle && (
                <track
                  kind="subtitles"
                  src={subtitleTrackUrl(subtitle, session.infoHash)}
                  label={subtitleLabel(subtitle)}
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

/** URL for the in-browser <track> element. Torrent-embedded subs live under
 *  /stream/:hash/subtitles/:index; OpenSubtitles subs under a global path
 *  keyed on file_id. Returns an empty string when the caller passes a
 *  torrent track without an infoHash (shouldn't happen — the picker is
 *  gated on session.infoHash). */
function subtitleTrackUrl(
  track: SubtitleTrack,
  infoHash: string | null,
): string {
  if (track.source === "torrent") {
    if (!infoHash) return "";
    return `/stream/${infoHash}/subtitles/${track.index}`;
  }
  return `/api/subtitles/opensubtitles/${track.fileId}`;
}

/** Display label for a track — the picker shows this on the trigger button
 *  and the <track> element uses it as the `label` attribute. OS tracks use
 *  the full language name; torrent tracks use the heuristic language guess. */
function subtitleLabel(track: SubtitleTrack): string {
  return track.source === "torrent" ? track.language : track.languageName;
}

/** Stable identity string for the <video> re-key. Different sources with the
 *  same numeric index/id shouldn't collide, so we prefix with the source tag. */
function subtitleKey(track: SubtitleTrack | null): string {
  if (!track) return "none";
  return track.source === "torrent" ? `t:${track.index}` : `os:${track.id}`;
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
