import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /** Delay before hiding after `showNow()`. Default 3000ms (Netflix parity). */
  hideAfterMs?: number;
  /**
   * Bar only auto-hides while playing. When false the bar stays open — a
   * user who paused is looking at something and shouldn't have to nudge the
   * mouse to see the controls.
   */
  isPlaying: boolean;
  /**
   * External "please keep open" flag — e.g. a Radix Popover is open, or the
   * user is scrubbing, or buffering is in progress. While true, the hide
   * timer is not armed; when it flips to false, we re-arm.
   */
  keepOpen?: boolean;
}

/**
 * Auto-hide bar behavior extracted so `PlayerControls` and any future overlay
 * layers can share the same "show on activity, hide after idle" semantics.
 *
 * Consumers wire:
 *   - `showNow()` on window/container mousemove
 *   - `cancelHide()` on bar mouseenter (never hide while hovering the bar)
 *   - `scheduleHide()` on bar mouseleave (re-arm the timer)
 *
 * The hook keeps a single window-scoped timer; overlapping calls reset it
 * rather than stacking. Cleanup on unmount cancels the pending timer.
 *
 * Internal design: we track a `hiddenByTimer` bit as the only piece of
 * mutable state. The public `visible` value is derived per-render as
 * `!hiddenByTimer || !isPlaying || keepOpen`. This lets us satisfy the
 * react-hooks/set-state-in-effect rule — no effect sets `visible` (it's
 * derived), and effects only clear the hide timer / bit as needed.
 */
export function useAutoHide(options: Options): {
  visible: boolean;
  showNow: () => void;
  cancelHide: () => void;
  scheduleHide: () => void;
} {
  const { hideAfterMs = 3000, isPlaying, keepOpen = false } = options;
  const [hiddenByTimer, setHiddenByTimer] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track the latest values so the timer's setTimeout callback re-checks them
  // at fire-time (the closure captures stale values otherwise). Refs are
  // updated in an effect; timers still work off render-time closures.
  const isPlayingRef = useRef(isPlaying);
  const keepOpenRef = useRef(keepOpen);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
    keepOpenRef.current = keepOpen;
  }, [isPlaying, keepOpen]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const armTimer = useCallback(() => {
    clearTimer();
    if (!isPlaying || keepOpen) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Re-check invariants at fire-time via refs — the closure captured
      // whatever isPlaying/keepOpen were when armTimer ran; the real values
      // may have changed since. Cheaper than re-arming on every prop change.
      if (!isPlayingRef.current || keepOpenRef.current) return;
      setHiddenByTimer(true);
    }, hideAfterMs);
  }, [clearTimer, hideAfterMs, isPlaying, keepOpen]);

  const showNow = useCallback(() => {
    setHiddenByTimer(false);
    armTimer();
  }, [armTimer]);

  const cancelHide = useCallback(() => {
    clearTimer();
    setHiddenByTimer(false);
  }, [clearTimer]);

  const scheduleHide = useCallback(() => {
    armTimer();
  }, [armTimer]);

  // When the invariants flip, we may need to clear a stale timer or re-arm.
  // We only touch the timer here — never setState — so this effect is
  // lint-clean under react-hooks/set-state-in-effect. Visibility is derived
  // from `hiddenByTimer` + `isPlaying` + `keepOpen` in the return, so a
  // pause / popover-open takes effect on the next render without an effect.
  useEffect(() => {
    if (!isPlaying || keepOpen) {
      // Cancel any pending hide — we don't want it firing behind a paused
      // player and setting hiddenByTimer while visible is being derived to true.
      clearTimer();
      return;
    }
    // Playing + not-kept-open: (re-)arm the hide countdown.
    armTimer();
  }, [isPlaying, keepOpen, armTimer, clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  // Visibility is derived. `hiddenByTimer` is the only bit we track; any
  // invariant that says "stay open" wins.
  const visible = !hiddenByTimer || !isPlaying || keepOpen;

  return { visible, showNow, cancelHide, scheduleHide };
}
