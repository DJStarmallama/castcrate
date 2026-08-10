# player-controls — Context

**Last updated:** 2026-08-09
**Status:** In progress — Netflix-style custom browser controls (initial pass)

## Problem

Native `<video controls>` gave the user "no play options like a hover bar"
during Chromecast-facing testing. Native browser HUDs auto-hide after ~2-3s
on Chrome, they don't expose casting/subtitle affordances, and their look is
inconsistent with the rest of the app (see `CastControls.tsx` for the target
visual language). The user asked for "a full suite of actions on both in
browser or casting like a stream service".

## Goal

Replace `controls` on the local browser `<video>` with a custom overlay bar
that mirrors the Netflix/YouTube experience: auto-hide when idle, seek with
buffered ranges + hover preview, ±10s skip, play/pause, volume + mute,
subtitle menu, cast menu, fullscreen, keyboard shortcuts. Cast surface
(`CastControls.tsx`) is out of scope — that's the on-TV branch.

## Non-goals

- Any change to the cast surface (`CastControls.tsx`).
- Any change to the buffer state machine (`useBufferState.ts` — consume, don't modify).
- Any change to how `playUrl` is constructed.
- Picture-in-Picture (future enhancement).
- Touch/mobile-first ergonomics — desktop-first, mouse+keyboard.
- Custom fullscreen HUD (browser native HUD still handles iOS quirks).

## Scope

In:
- New `PlayerControls.tsx` component overlaying the `<video>` element.
- Custom seek bar with buffered ranges, hover preview, optimistic scrub.
- Transport row (play/pause, ±10s, volume + mute).
- Title + episode context in the middle.
- Integrated SubtitlePicker + CastBar + fullscreen toggle on the right.
- Auto-hide after 3s of mouse idle (only while playing).
- Keyboard shortcuts (Space / arrows / M / F / C).
- Double-click on video toggles fullscreen.
- `useFormatTime` helper extracted to `lib/format.ts` (shared with CastControls).

Out:
- Any changes to `CastControls.tsx`.
- Any changes to `useBufferState.ts`.
- Any changes to server code.
- Removing the header row (kept intact — file picker, transcode badge, close button).

## Decisions

- **New feature folder** rather than extending `player-buffer-ux`. The buffer
  UX is about swarm-health signalling; this is a UI surface replacement. The
  two overlap on the video container but the concerns are orthogonal.
- **Bar rendered inside the same `<video>` container**, not portalled. It
  needs to know pixel-precise positions relative to the video (for the seek
  bar) and Radix Popovers still portal their own contents to `#overlay-root`
  for stacking-context safety.
- **BufferingOverlay stays on top of the bar**, both layers coexist. The
  overlay's `pointer-events-none` on the outer div keeps clicks flowing
  through to the bar underneath, and its `pointer-events-auto` inner card
  captures clicks on the info panel itself.
- **SubtitlePicker + CastBar move INTO the new bar's right side**, replacing
  the header versions. Header still has: title, file picker, transcode badge,
  Stop & close. Rationale: keeps discovery in one canonical place (the bar),
  matches Netflix/YouTube muscle memory (bottom-right), and gives us more
  header space for the title. Fullscreen toggle also moves.
- **Optimistic seek during drag.** Playhead position updates immediately on
  mousemove while dragging; the actual `<video>.currentTime` write happens
  on mouseup. Prevents the jitter/rubberbanding effect that we hit on cast
  controls before the optimistic patch.
- **Keyboard listeners on `window`, guarded on `document.activeElement`.**
  Same shape as the existing `F` fullscreen shortcut. Skip when focus is in
  `INPUT`, `TEXTAREA`, or `SELECT`, or when a Radix Popover is open (it
  eats Space/Escape itself).
- **Auto-hide honors Radix Popover open state.** Track subtitle + cast open
  flags in the parent so the hide timer is cancelled while either is open.
- **Volume slider always visible** in the transport row. A collapsing volume
  is nice but adds a whole state to keyboard/hover choreography for little
  gain given the always-mounted desktop bar.
- **±10s skip** matches CastControls symmetry — the user muscle-memory should
  survive across cast/local surfaces. Shift+Arrow = ±30s for the impatient.
- **Cursor hidden with bar** via `cursor-none` class on the container when
  bar is hidden. Restored on `mousemove`. Standard Netflix/YouTube behavior.

## Gotchas

- **`<video>.buffered` is a `TimeRanges` (not an array).** Iterate by
  `buffered.length` + `.start(i)` / `.end(i)`. Chrome usually collapses to a
  single range; Safari sometimes reports several disjoint ranges (especially
  during seek).
- **`waiting` / `canplay` may not fire the way you expect during scrub.**
  Fast scrubbing on a partial stream drops us back into `waiting` and the
  buffer overlay flashes — currently that's the acceptable price; a debounce
  would fight the state machine. Live with it for v1.
- **Chrome autoplay policy** can suppress `playing` until user click; overlay
  covers video click area. This is why `useBufferState` prefers `canplay`
  over `playing` for the dismiss latch. Not new here; noted so a future edit
  doesn't accidentally add a click-through capture that swallows the click.
- **`<video controls>` was replaced** — do NOT reintroduce that attribute or
  the browser stacks two control layers.
- **Radix Popover `data-state`** could drive the auto-hide guard from CSS,
  but React state is simpler and lets us keep the timer logic in one place.
- **Double-click-to-fullscreen must ignore clicks on the bar itself.** Attach
  the listener to the video element (or a wrapper stopPropagation'd to bar
  clicks). We wire the listener on the video specifically so bar clicks
  never bubble up.
- **Space repeats.** `keydown` on an unfocused body fires per press, not per
  autorepeat, so Space toggles play/pause on each tap — good. But if the
  user holds Space, Chrome auto-repeats and we get many toggles. Guard on
  `event.repeat`.

## Session notes

### 2026-08-09 — Initial implementation

Landed the full custom control layer. Files touched below; commit in the
final report.

**New files**
- `apps/web/src/components/PlayerControls.tsx` — the bar itself.
- `apps/web/src/hooks/useAutoHide.ts` — reusable hide-after-idle behavior
  with mouse-move / hover cancellation and external "keep open" guards.

**Modified**
- `apps/web/src/components/Player.tsx` — removed `controls` on `<video>`,
  moved `SubtitlePicker`, `CastBar`, and the fullscreen toggle into the new
  bar, added double-click-to-fullscreen on the video, added the keyboard
  shortcuts (Space / arrows / M / C / Shift+arrows for ±30s), wired the
  auto-hide state to the video's `<video>` element ref.
- `apps/web/src/lib/format.ts` — added `formatTime()` helper (extracted
  from CastControls, now reused by both surfaces).
- `apps/web/src/components/CastControls.tsx` — swapped in `formatTime` from
  `lib/format.ts` (behavior-identical; one source of truth).

**Native controls "invisible" mystery** — no smoking gun. The BufferingOverlay
uses `pointer-events-none` on its outer div, no other absolutely-positioned
layer sits over the video, and the `<video>` element's dimensions are fine.
Most likely explanation is Chrome's native HUD auto-hides after ~2-3s of
idle mouse and the user was seeing that auto-hidden state, not a broken
control layer. Custom controls make the point moot either way.

**Keyboard shortcuts wired**
- `Space` — play/pause (guarded on `event.repeat`)
- `ArrowLeft` / `ArrowRight` — seek ±10s (Shift = ±30s)
- `ArrowUp` / `ArrowDown` — volume ±0.05
- `M` / `m` — mute toggle
- `F` / `f` — fullscreen toggle (was already wired; kept)
- `C` / `c` — subtitle menu open (dispatches into an imperative open state
  on `PlayerControls` via a ref-callback pattern)
- `Escape` — Radix Popover handles subtitle/cast closes; browser handles
  fullscreen exit

Skipped when `document.activeElement` is `INPUT`, `TEXTAREA`, `SELECT`, or
has `contentEditable`. Same shape as the pre-existing `F` shortcut.

**SubtitlePicker + CastBar integration** — moved INTO the new bar
(bottom-right). Removed from the header. Header now has: movie title / file
picker / transcode badge / Stop & close. Simpler, more consistent, and
mirrors Netflix's own bottom-bar layout.

### 2026-08-10 — Deployed to the box

- Landed via `e5b8169` merge; deployed to `castcrate.local`. Browser bundle bumped from ~385 kB → 398 kB gzipped, no runtime issues in journal.
- **Not yet manually verified interactively** — the reported invisible native controls were the reason we rewrote rather than diagnosed further. Next session should cast-test:
  - Bar appears on hover, hides after 3s while playing, stays while paused/buffering
  - Space / ← → (±10s) / M / F / C / ↑ ↓ / Esc all fire correctly
  - Double-click video toggles fullscreen
  - Seek scrub tooltip renders on hover
  - Subtitle picker (now inside the bar) surfaces both torrent-embedded AND OpenSubtitles tracks
  - Casting: picking an OS track hot-swaps on the TV via EDIT_TRACKS_INFO
