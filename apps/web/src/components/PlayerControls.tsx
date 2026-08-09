import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import { CastBar } from "./CastBar";
import { SubtitlePicker } from "./SubtitlePicker";
import type { SubtitleTrack } from "../lib/api";
import { formatTime } from "../lib/format";

/**
 * A ref-callback handle for the parent to imperatively drive things that
 * live in the bar — currently just "open the subtitle picker for the C
 * keyboard shortcut". More surfaces (chapter menu, quality picker) could
 * plug in here without a Context.
 */
export interface PlayerControlsHandle {
  openSubtitleMenu: () => void;
}

interface Props {
  /**
   * Ref to the <video> element the bar controls. We take a ref rather than
   * the element itself so that mutating `videoRef.current.currentTime` etc.
   * doesn't trigger the react-hooks immutability rule (the ref is not a prop
   * value, its `.current` is). `videoElement` is the parent's re-render
   * trigger — it flips from null to the element when mount happens, and the
   * RAF loop below re-arms accordingly.
   */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Bumps whenever the underlying <video> element mounts/unmounts, so the
   *  RAF loop can restart against the new node. Passing this separately from
   *  the ref keeps the write-path lint-clean. */
  videoElement: HTMLVideoElement | null;
  /** Parent-owned visibility (see useAutoHide). */
  visible: boolean;
  /** Cancel the parent's hide timer while the mouse is over the bar. */
  onMouseEnter: () => void;
  /** Re-arm the parent's hide timer when the mouse leaves the bar. */
  onMouseLeave: () => void;

  title: string;
  subtitleContext?: string;

  infoHash: string | null;
  /** IMDb id — enables OpenSubtitles fallback in SubtitlePicker/CastBar. */
  imdbId?: string;
  subtitle: SubtitleTrack | null;
  onSubtitleChange: (t: SubtitleTrack | null) => void;
  castSessionId: string | null;
  onCastSessionChange: (id: string | null) => void;
  streamPath: string;
  posterUrl?: string | null;
  contentType?: string;
  stremioHttpStream?: boolean;

  isFullscreen: boolean;
  onToggleFullscreen: () => void;

  /**
   * Open-flag callbacks. The parent uses these to suppress the auto-hide
   * timer while a Popover is open — otherwise the user hovers off the bar
   * to click through the popover and the whole thing vanishes.
   */
  onSubtitleOpenChange: (open: boolean) => void;
  onCastOpenChange: (open: boolean) => void;

  /**
   * Optional ref that the parent can call to imperatively open the subtitle
   * menu (used by the "C" keyboard shortcut). We accept a MutableRefObject
   * rather than a callback so ownership stays with the parent.
   */
  handleRef?: MutableRefObject<PlayerControlsHandle | null>;
}

/**
 * Netflix-style custom control bar layered over the local `<video>`. Reads
 * state from the video element via a requestAnimationFrame loop (only while
 * `visible` — no work when the bar is hidden). Writes back on user input,
 * with optimistic scrub semantics (visible playhead updates immediately;
 * `<video>.currentTime` is committed on pointerup).
 *
 * Not used when casting — the cast branch renders `CastControls` instead.
 */
export function PlayerControls(props: Props) {
  const {
    videoRef,
    videoElement,
    visible,
    onMouseEnter,
    onMouseLeave,
    title,
    subtitleContext,
    infoHash,
    imdbId,
    subtitle,
    onSubtitleChange,
    castSessionId,
    onCastSessionChange,
    streamPath,
    posterUrl,
    contentType,
    stremioHttpStream,
    isFullscreen,
    onToggleFullscreen,
    onSubtitleOpenChange,
    onCastOpenChange,
    handleRef,
  } = props;

  // Mirror the parts of <video> state we render. Updated by a RAF loop while
  // visible — polling avoids a firehose of React re-renders on every
  // timeupdate but stays smooth enough for a seek bar.
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [buffered, setBuffered] = useState<Array<{ start: number; end: number }>>([]);

  // Optimistic scrub: while the user is dragging the seek bar we update
  // `optimisticSeek` (visible playhead) instead of pushing to the video.
  // On pointerup we commit currentTime = optimisticSeek and clear.
  const [optimisticSeek, setOptimisticSeek] = useState<number | null>(null);
  const isDraggingRef = useRef(false);

  // Hover preview: track the mouse X → time on the seek row so we can render
  // a small time chip above the cursor. Null = hidden.
  const [hoverTime, setHoverTime] = useState<{ time: number; x: number } | null>(null);
  const seekRowRef = useRef<HTMLDivElement>(null);

  // Imperative subtitle popover open. We keep it controlled here (rather
  // than in SubtitlePicker) so the "C" keyboard shortcut can flip it.
  const [subtitleOpen, setSubtitleOpen] = useState(false);
  const [castOpen, setCastOpen] = useState(false);

  // Expose the imperative handle to the parent via the mutable ref pattern.
  // This is what the Player.tsx "C" keyboard shortcut targets.
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      openSubtitleMenu: () => setSubtitleOpen((prev) => !prev),
    };
    return () => {
      if (handleRef.current) handleRef.current = null;
    };
  }, [handleRef]);

  // Propagate open flags upward so the parent can gate auto-hide.
  useEffect(() => onSubtitleOpenChange(subtitleOpen), [subtitleOpen, onSubtitleOpenChange]);
  useEffect(() => onCastOpenChange(castOpen), [castOpen, onCastOpenChange]);

  // RAF loop: poll the video element for playhead/duration/buffered while
  // the bar is visible. When hidden we skip the loop — bar isn't rendering
  // anything sensitive to those values anyway. Optimistic scrub short-
  // circuits the currentTime read so a drag doesn't flicker against RAF.
  //
  // Depends on `videoElement` so the effect re-runs when the underlying
  // <video> mounts/unmounts. Inside the tick we read from videoRef.current
  // so we always see the live node.
  useEffect(() => {
    if (!videoElement || !visible) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const v = videoRef.current;
      if (!v) return;
      if (!isDraggingRef.current) setCurrentTime(v.currentTime);
      // Guard against Infinity/NaN before first metadata — passing that to
      // the range input's max produces a broken slider.
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      setDuration(d);
      setPaused(v.paused);
      setMuted(v.muted);
      setVolume(v.volume);
      const ranges: Array<{ start: number; end: number }> = [];
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) {
        ranges.push({ start: b.start(i), end: b.end(i) });
      }
      setBuffered(ranges);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoElement, videoRef, visible]);

  // -- transport handlers ---------------------------------------------------
  //
  // These all read from videoRef.current rather than a `video` prop — that
  // keeps the writes lint-clean under react-hooks/immutability (mutating a
  // prop is forbidden; mutating the current field of a ref is idiomatic).

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, [videoRef]);

  const skipBy = useCallback(
    (seconds: number) => {
      const v = videoRef.current;
      if (!v) return;
      const target = Math.max(0, Math.min(v.duration || 0, v.currentTime + seconds));
      v.currentTime = target;
    },
    [videoRef],
  );

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }, [videoRef]);

  const setVolumeValue = useCallback(
    (value: number) => {
      const v = videoRef.current;
      if (!v) return;
      const clamped = Math.max(0, Math.min(1, value));
      v.volume = clamped;
      // Unmute on any drag off zero — matches Netflix/YouTube; a user pulling
      // the slider up while muted expects to actually hear something.
      if (clamped > 0 && v.muted) v.muted = false;
    },
    [videoRef],
  );

  // -- seek bar handlers ----------------------------------------------------

  const commitSeek = useCallback(
    (value: number) => {
      const v = videoRef.current;
      if (!v) return;
      const clamped = Math.max(0, Math.min(v.duration || value, value));
      v.currentTime = clamped;
    },
    [videoRef],
  );

  const onSeekPointerDown = useCallback(() => {
    isDraggingRef.current = true;
  }, []);

  const onSeekPointerUp = useCallback(() => {
    isDraggingRef.current = false;
    if (optimisticSeek !== null) {
      commitSeek(optimisticSeek);
      // Let the RAF pick up the new currentTime; clear on next paint so the
      // playhead doesn't visually snap to the pre-commit position for a frame.
      requestAnimationFrame(() => setOptimisticSeek(null));
    }
  }, [commitSeek, optimisticSeek]);

  const onSeekChange = useCallback(
    (raw: string) => {
      const v = Number(raw);
      if (isDraggingRef.current) {
        setOptimisticSeek(v);
      } else {
        // Keyboard nudge on the range (arrow keys focused on the slider):
        // commit immediately, no drag phase.
        commitSeek(v);
      }
    },
    [commitSeek],
  );

  // Time chip on seek row hover. Positioned absolutely using the mouse X
  // relative to the row. Duration = 0 case is guarded — chip hidden.
  const onSeekRowMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const row = seekRowRef.current;
      if (!row || duration === 0) return;
      const rect = row.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, x / rect.width));
      setHoverTime({ time: pct * duration, x });
    },
    [duration],
  );

  const onSeekRowMouseLeave = useCallback(() => setHoverTime(null), []);

  // -- render ---------------------------------------------------------------

  const displayTime = optimisticSeek ?? currentTime;
  const displayVolume = muted ? 0 : volume;

  const bufferedPct = useMemo(() => {
    if (duration === 0) return [];
    return buffered.map((r) => ({
      left: (r.start / duration) * 100,
      width: ((r.end - r.start) / duration) * 100,
    }));
  }, [buffered, duration]);

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-10 flex flex-col justify-end transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      aria-hidden={!visible}
    >
      {/* subtle gradient at the bottom so text/icons stay readable over any
          video frame; also gives the bar a "chin" that feels less like a
          floating box. Purely decorative — no pointer events here. */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-40 bg-gradient-to-t from-black/85 via-black/45 to-transparent" />

      <div
        // pointer-events-auto only when visible; when hidden the bar's chrome
        // shouldn't intercept clicks meant for the underlying <video> (which
        // handles click-to-play/pause and double-click-to-fullscreen).
        className={`relative px-6 pb-4 pt-2 ${
          visible ? "pointer-events-auto" : "pointer-events-none"
        }`}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {/* --- seek row --- */}
        <div
          ref={seekRowRef}
          className="relative pt-3"
          onMouseMove={onSeekRowMouseMove}
          onMouseLeave={onSeekRowMouseLeave}
        >
          {/* Buffered ranges. Rendered as bars beneath the slider. Absolute
              positioning inside the row; the slider is z-10 on top. */}
          <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/15">
            {bufferedPct.map((b, i) => (
              <div
                key={i}
                className="absolute inset-y-0 bg-white/35"
                style={{ left: `${b.left}%`, width: `${b.width}%` }}
              />
            ))}
            {/* Played portion — thin emerald fill matching the app accent. */}
            <div
              className="absolute inset-y-0 bg-emerald-400"
              style={{ width: `${duration ? (displayTime / duration) * 100 : 0}%` }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(displayTime, duration || displayTime)}
            onPointerDown={onSeekPointerDown}
            onPointerUp={onSeekPointerUp}
            onPointerCancel={onSeekPointerUp}
            onChange={(e) => onSeekChange(e.target.value)}
            disabled={duration === 0}
            aria-label="Seek"
            className="peer relative z-10 h-2 w-full cursor-pointer appearance-none bg-transparent [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-emerald-400 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-400"
          />
          {/* Hover time chip. Positioned above the slider at cursor X. */}
          {hoverTime && (
            <div
              className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 rounded bg-black/85 px-2 py-1 text-xs text-zinc-100 shadow-lg"
              style={{ left: `${hoverTime.x}px` }}
            >
              {formatTime(hoverTime.time)}
            </div>
          )}
          <div className="mt-2 flex justify-between text-xs text-zinc-300">
            <span>{formatTime(displayTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* --- transport row --- */}
        <div className="mt-2 flex items-center gap-3">
          {/* left cluster */}
          <IconButton onClick={togglePlay} title={paused ? "Play (Space)" : "Pause (Space)"}>
            {paused ? <Play /> : <Pause />}
          </IconButton>
          <IconButton onClick={() => skipBy(-10)} title="Back 10s (←)">
            <SkipBack />
          </IconButton>
          <IconButton onClick={() => skipBy(10)} title="Forward 10s (→)">
            <SkipForward />
          </IconButton>

          {/* volume cluster */}
          <div className="ml-2 flex items-center gap-2">
            <IconButton onClick={toggleMute} title={muted ? "Unmute (M)" : "Mute (M)"}>
              {muted ? <VolumeMuted /> : volume > 0.5 ? <VolumeFull /> : <VolumeLow />}
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={displayVolume}
              onChange={(e) => setVolumeValue(Number(e.target.value))}
              aria-label="Volume"
              className="h-1 w-24 cursor-pointer accent-emerald-400"
            />
          </div>

          {/* center: title + episode context. Truncates on narrow widths. */}
          <div className="mx-4 min-w-0 flex-1 text-center">
            <p className="truncate text-sm font-medium text-zinc-100">{title}</p>
            {subtitleContext && (
              <p className="truncate text-xs text-zinc-400">{subtitleContext}</p>
            )}
          </div>

          {/* right cluster: subtitles / cast / fullscreen */}
          {infoHash && (
            <SubtitlePicker
              infoHash={infoHash}
              imdbId={imdbId}
              selected={subtitle}
              onSelect={onSubtitleChange}
              castSessionId={castSessionId}
              open={subtitleOpen}
              onOpenChange={setSubtitleOpen}
            />
          )}
          <CastBar
            streamPath={streamPath}
            title={title}
            posterUrl={posterUrl}
            contentType={contentType}
            sessionId={castSessionId}
            onSessionChange={onCastSessionChange}
            subtitle={subtitle}
            infoHash={infoHash ?? undefined}
            imdbId={imdbId}
            stremioHttpStream={stremioHttpStream}
            open={castOpen}
            onOpenChange={setCastOpen}
          />
          <IconButton
            onClick={onToggleFullscreen}
            title={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
          >
            {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function IconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-zinc-100 transition hover:bg-white/20"
    >
      {children}
    </button>
  );
}

const ICON: React.SVGProps<SVGSVGElement> = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "currentColor",
};

function Play() {
  return (
    <svg {...ICON}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function Pause() {
  return (
    <svg {...ICON}>
      <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
    </svg>
  );
}
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
