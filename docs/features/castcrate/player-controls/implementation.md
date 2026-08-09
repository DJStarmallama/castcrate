# Feature: player-controls — Netflix-style custom browser controls

**Status:** In progress
**Authored:** 2026-08-09

## Executive summary

Replace `<video controls>` on the local browser playback surface with a custom
overlay bar (`PlayerControls.tsx`) that provides Netflix/YouTube-parity
affordances: auto-hiding bottom bar with seek + transport + volume + subtitles
+ cast + fullscreen, plus keyboard shortcuts. Cast surface (`CastControls.tsx`)
is untouched — it's the "on TV" branch, out of scope.

---

## Architecture

```
Player (unchanged surface)
  ├── header  (title | file picker | transcode badge | Stop & close)  ← trimmed
  ├── stage
  │    ├── <video>                (controls attribute removed)
  │    ├── BufferingOverlay       (pointer-events-none outer; unchanged)
  │    └── PlayerControls         (new — bar overlay + keyboard shortcuts)
  │         ├── seek row
  │         ├── transport row (play / ±10s / volume+mute / title / subtitle / cast / fullscreen)
  │         └── (Radix Popovers portalled to #overlay-root as today)
  └── footer  (unchanged ProgressBar)

hooks/
  └── useAutoHide.ts   (new — timer + hover / open-flag guards, cursor toggle)

lib/format.ts
  └── formatTime()     (extracted from CastControls, reused)
```

## Key files

| Path | Role |
|---|---|
| `apps/web/src/components/PlayerControls.tsx` | **new** — the custom bar |
| `apps/web/src/hooks/useAutoHide.ts` | **new** — hide-after-idle behavior |
| `apps/web/src/components/Player.tsx` | remove `controls`, mount `PlayerControls`, drop moved header buttons, wire keyboard shortcuts, add double-click fullscreen |
| `apps/web/src/lib/format.ts` | add `formatTime()` |
| `apps/web/src/components/CastControls.tsx` | consume the shared `formatTime` (behavior-identical) |

## PlayerControls contract

```ts
interface Props {
  video: HTMLVideoElement | null;   // controlled target
  visible: boolean;                 // parent-owned via useAutoHide
  onMouseEnter: () => void;         // cancels the hide timer
  onMouseLeave: () => void;         // starts the hide timer if applicable

  // header content, moved into the bar
  title: string;
  subtitleContext?: string;         // e.g. "S02E04 · Some Episode"

  // integrated affordances
  infoHash: string | null;
  subtitle: SubtitleTrack | null;
  onSubtitleChange: (t: SubtitleTrack | null) => void;
  castSessionId: string | null;
  onCastSessionChange: (id: string | null) => void;
  streamPath: string;
  posterUrl?: string | null;
  contentType?: string;
  stremioHttpStream?: boolean;

  // fullscreen
  isFullscreen: boolean;
  onToggleFullscreen: () => void;

  // subtitle Popover open flag (so the bar can suppress auto-hide)
  onSubtitleOpenChange: (open: boolean) => void;
  onCastOpenChange: (open: boolean) => void;

  // imperative subtitle open trigger (for the "C" keyboard shortcut)
  subtitleOpenRef?: React.MutableRefObject<(() => void) | null>;
}
```

The bar imperatively reads `video.currentTime`, `video.duration`,
`video.paused`, `video.muted`, `video.volume`, and `video.buffered` via a
`requestAnimationFrame` polling loop while visible + playing. This keeps the
seek bar smooth without dispatching an event storm through React. During
scrub, the visible time is `optimisticSeek` (local state) instead of the
video's actual currentTime.

## useAutoHide contract

```ts
export function useAutoHide(options: {
  hideAfterMs?: number;       // default 3000
  isPlaying: boolean;         // never hide while paused
  keepOpen?: boolean;         // e.g. a Popover is open; suppresses hide
}): {
  visible: boolean;
  showNow: () => void;        // call on mousemove / touch
  cancelHide: () => void;     // call when the cursor enters the bar
  scheduleHide: () => void;   // call when the cursor leaves the bar
};
```

Implementation notes:
- `showNow()` sets `visible = true` and (re-)starts the hide timer if
  `isPlaying && !keepOpen`.
- `cancelHide()` clears the timer.
- `scheduleHide()` re-arms it if `isPlaying && !keepOpen`.
- Effect on `keepOpen`: if it flips from `true → false` while playing, arm
  the timer (so closing a Popover doesn't leave the bar stuck open).
- Effect on `isPlaying`: if it flips to `false`, cancel the timer (paused
  keeps bar visible).

## Seek bar

- Uses `<input type="range">` for accessibility + keyboard nudge, styled with
  Tailwind + `accent-emerald-500`.
- Buffered ranges rendered as a translucent white layer beneath the accent
  track using a positioned `<div>` per range. `left` = `start/duration`,
  `width` = `(end - start)/duration`. Recomputed each RAF tick.
- Hover preview: `onMouseMove` on the wrapper computes the position → time,
  places a small time chip absolutely at the mouse X.
- Drag: `onMouseDown` on the range sets `dragging = true`; `onChange` updates
  `optimisticSeek` only; `onMouseUp` (or `onChange` when `dragging === false`)
  writes `video.currentTime = value`. Also supports keyboard Left/Right on
  the range for A11y, which fall through to `onChange` and commit immediately.

## Transport row

- Play/Pause circle (matches CastControls sizing `h-14 w-14`? — bar version
  uses `h-12 w-12` to fit the bar height).
- Skip ±10s buttons on either side.
- Volume icon flips between full/low/muted using the same threshold pattern
  as CastControls (0.5 boundary).
- Volume slider always visible.
- Title/subtitle context centered in the row (truncated on narrow widths).
- Right side: subtitle picker button (opens popover; `C` shortcut also opens),
  cast button (opens popover), fullscreen toggle.

## Keyboard shortcuts

Attached at `window` in `Player.tsx` (the parent) so they're only live while
the player is mounted. Guarded on `document.activeElement`:

```ts
function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}
```

- `Space` (guarded on `event.repeat`) — toggle play/pause via `video.paused`
- `ArrowLeft` / `ArrowRight` — `video.currentTime ± 10` (`+ shift ? 30 : 10`)
- `ArrowUp` / `ArrowDown` — `video.volume = clamp(video.volume ± 0.05, 0, 1)`
- `M` / `m` — `video.muted = !video.muted`
- `F` / `f` — existing behavior — kept
- `C` / `c` — call `subtitleOpenRef.current?.()` — opens the subtitle popover

Any of these also calls `showNow()` on the auto-hide state so the bar reveals
in response to keyboard interaction.

## Double-click fullscreen

Attach `onDoubleClick` to the `<video>` element (not the container — so bar
double-clicks don't trigger). Calls `toggleFullscreen()`.

## Integration with existing surfaces

- **BufferingOverlay** stays exactly as-is. It renders SIBLING to the video
  and PlayerControls; its outer div is `pointer-events-none` so bar clicks
  pass through to the bar (bar is above overlay in DOM order for
  interactivity; overlay is above video visually via `absolute inset-0`).
  Since both are `absolute inset-0`, the later-mounted one wins at overlap
  points — but PlayerControls' bar is only the bottom strip, and the
  overlay's card sits in the vertical center. They don't visually collide.
- **SubtitlePicker + CastBar** move OUT of the header and into the bar's
  right side. Their internal implementation is unchanged — they still portal
  to `#overlay-root` via Radix. The bar exposes `onSubtitleOpenChange` /
  `onCastOpenChange` to the parent so the auto-hide can be suppressed while
  either is open.
- **Fullscreen toggle** moves from header to bar; the existing `F` shortcut
  in Player.tsx is retained (extended to include the new shortcut set).
- **useBufferState** — unchanged. Bar consumes nothing from it. Overlay
  still drives on its state.

## Do NOT

- Reintroduce `<video controls>`.
- Change `CastControls.tsx`.
- Change `useBufferState.ts`.
- Change server behavior.
- Introduce new dependencies (plain React + existing Radix + Tailwind).
