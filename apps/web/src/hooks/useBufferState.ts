import { useReducer } from "react";

/**
 * Explicit state machine for the torrent playback buffering UX.
 *
 * Extracted from the previously-informal `hasPlayedOnce` + `videoBuffering` +
 * `stalled` triad scattered across `Player.tsx` and its inlined overlay.
 * Consolidating the transitions here so Phases 2/3 (dead-swarm CTA,
 * buffer-to-N% dialog) have a single readable target instead of three
 * conditional-render blobs.
 *
 * States:
 *   - `idle` — session not yet active (or HTTP-stream sessions that skip the
 *     machine entirely).
 *   - `initial-buffer` — torrent added; browser hasn't received enough data
 *     to fire the first `canplay` event. Overlay shows "Buffering…".
 *   - `buffering` — mid-play underrun. The browser fired `waiting` after
 *     playback had already started. Overlay shows "Buffering — waiting for
 *     more data".
 *   - `playing` — video element has fired `canplay` or `playing`; playback
 *     is stable. Overlay hidden.
 *   - `initial-stalled` — swarm progress hasn't moved for
 *     `DEAD_SWARM_THRESHOLD_MS`, and the video hasn't started yet. Overlay
 *     shows "Waiting for peers…" without a spinner.
 *   - `stalled` — swarm progress hasn't moved for
 *     `DEAD_SWARM_THRESHOLD_MS`, mid-play. Overlay shows the same "Waiting
 *     for peers…" copy. Split from `initial-stalled` so `recovered` can
 *     restore the correct pre-stall state (initial vs. mid-play).
 *   - `error` — unrecoverable playback failure. Reserved for future use;
 *     the current implementation doesn't dispatch `error`, but the shape is
 *     in place for Phase 2's dead-swarm-CTA + `<video>` `error` event wiring.
 *
 * The reducer intentionally treats `stall_detected` while `playing` as a
 * no-op. That matches the pre-refactor behavior — the old `stalled` flag was
 * only surfaced from *inside* the overlay, which was hidden when the video
 * was playing. Callers should dispatch `stall_detected` repeatedly (once per
 * poll while the stall condition holds) so the transition takes effect the
 * moment we drop back into `buffering`.
 */
export type BufferState =
  | "idle"
  | "initial-buffer"
  | "buffering"
  | "playing"
  | "initial-stalled"
  | "stalled"
  | "error";

export type BufferEvent =
  /** Session starting — reset to `initial-buffer`. Called once per playback. */
  | { type: "start" }
  /**
   * `<video>` fired `canplay` — has enough data to play. Overlay-dismiss
   * latch. Used in preference to `playing` because Chrome's autoplay policy
   * can suppress `playing` until user interaction, leaving the overlay stuck.
   */
  | { type: "buffered" }
  /** `<video>` fired `playing`. Same overlay-dismiss semantics as `buffered`. */
  | { type: "playing" }
  /** `<video>` fired `waiting` — buffer drained mid-play. */
  | { type: "waiting" }
  /**
   * Swarm has not made progress for at least `DEAD_SWARM_THRESHOLD_MS`.
   * `sinceMs` is how long ago progress last moved (ms). Reserved for the
   * dead-swarm CTA in Phase 2; currently informational only.
   */
  | { type: "stall_detected"; sinceMs: number }
  /** Swarm resumed making progress. */
  | { type: "recovered" }
  /** Unrecoverable playback error. */
  | { type: "error"; message: string }
  /** Return to `idle` (e.g. tear-down before another `start`). */
  | { type: "reset" };

/**
 * When the swarm has made zero progress for this long, we treat the torrent
 * as effectively dead and surface it in the overlay. Was a magic 10_000 ms
 * `STALL_THRESHOLD_MS` inside `Player.tsx`; centralized here so Phase 2's
 * dead-swarm CTA and the server's readiness gate use the same number.
 *
 * The implementation.md spec calls for 30_000 ms once the CTA lands. The
 * current shipped behavior uses 10_000 ms — bumping it now would be a
 * user-visible change, so we ship the constant AT the current threshold and
 * bump it as part of Phase 2 when the CTA lands with it.
 */
export const DEAD_SWARM_THRESHOLD_MS = 10_000;

/**
 * Pure reducer. Every (state, event) pair is handled explicitly — no
 * catch-all fall-throughs — so the transition table is auditable by
 * reading top-to-bottom.
 */
export function bufferReducer(state: BufferState, event: BufferEvent): BufferState {
  // `reset` and `start` are global — same behavior from every state.
  if (event.type === "reset") return "idle";
  if (event.type === "start") return "initial-buffer";
  if (event.type === "error") return "error";

  switch (state) {
    case "idle":
      // In `idle` we ignore video/swarm events entirely — dispatchers should
      // send `start` first. This matches the HTTP-stream case where the
      // Player never dispatches anything and the state stays `idle` forever.
      return "idle";

    case "initial-buffer":
      switch (event.type) {
        case "buffered":
        case "playing":
          return "playing";
        case "waiting":
          // Already covering "no data yet" — waiting is redundant.
          return "initial-buffer";
        case "stall_detected":
          return "initial-stalled";
        case "recovered":
          return "initial-buffer";
      }
      return state;

    case "buffering":
      switch (event.type) {
        case "buffered":
        case "playing":
          return "playing";
        case "waiting":
          return "buffering";
        case "stall_detected":
          return "stalled";
        case "recovered":
          return "buffering";
      }
      return state;

    case "playing":
      switch (event.type) {
        case "buffered":
        case "playing":
          return "playing";
        case "waiting":
          return "buffering";
        case "stall_detected":
          // No-op while playing — matches pre-refactor behavior. The stall
          // signal was previously latched but only surfaced from inside the
          // overlay, which was hidden during stable playback. Callers should
          // re-dispatch `stall_detected` on every poll while the condition
          // holds so the next `waiting` transition sees it.
          return "playing";
        case "recovered":
          return "playing";
      }
      return state;

    case "initial-stalled":
      switch (event.type) {
        case "buffered":
        case "playing":
          return "playing";
        case "waiting":
          return "initial-stalled";
        case "stall_detected":
          return "initial-stalled";
        case "recovered":
          return "initial-buffer";
      }
      return state;

    case "stalled":
      switch (event.type) {
        case "buffered":
        case "playing":
          return "playing";
        case "waiting":
          return "stalled";
        case "stall_detected":
          return "stalled";
        case "recovered":
          return "buffering";
      }
      return state;

    case "error":
      // Only `reset`/`start`/`error` (handled above) can leave the error
      // state. Everything else is swallowed.
      return "error";
  }
}

/**
 * True when the buffering overlay should be visible for `state`. Kept as a
 * derived predicate so callers don't re-encode the "which states show the
 * overlay" rule.
 */
export function isBufferingState(state: BufferState): boolean {
  return (
    state === "initial-buffer" ||
    state === "buffering" ||
    state === "initial-stalled" ||
    state === "stalled"
  );
}

/**
 * True when the state represents a detected stall — used by the overlay to
 * swap the spinner + copy for the "Waiting for peers…" variant.
 */
export function isStalledState(state: BufferState): boolean {
  return state === "initial-stalled" || state === "stalled";
}

/**
 * True when the video hasn't produced its first `canplay` yet — used by the
 * overlay to pick the "Buffering…" vs "Buffering — waiting for more data"
 * copy.
 */
export function isInitialState(state: BufferState): boolean {
  return state === "initial-buffer" || state === "initial-stalled";
}

/**
 * Small `useReducer` wrapper so callers don't have to import the reducer
 * separately or plumb the initial state.
 */
export function useBufferState(): {
  state: BufferState;
  dispatch: (event: BufferEvent) => void;
} {
  const [state, dispatch] = useReducer(bufferReducer, "initial-buffer");
  return { state, dispatch };
}
