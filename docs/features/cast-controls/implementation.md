# Feature: cast-controls — Phase 7 (Retrospective)

**Status:** Implemented
**Documented:** 2026-05-09
**Phase:** 7 — refinements on top of Phase 3 (chromecast)

## Executive summary

Three refinements on the Phase 3 baseline:

1. **Refined cast controls.** `CastControls.tsx` becomes a full Now Playing panel — seek bar with time display, ±10s skip, play/pause, volume slider with mute, stop. Polls `/api/cast/sessions/:id` at 1s. Mute/unmute actions added to `castv2-client` dispatch.
2. **Browser fullscreen.** In-browser playback gets a fullscreen button + 'F' shortcut. Native browser HUD; no custom controls overlay.
3. **Search type filter.** All / Movies / TV pills above the result grid. Re-fetches when changed.

No new server services — additions to existing `cast.ts` (mute/unmute), `routes/cast.ts` (validate the new actions), and `routes/movies.ts` (single-pass when type is set).

---

## Architecture (delta vs Phase 3)

```
CastControls (Phase 3 minimal panel) → CastControls.tsx (full Now Playing)
   - seek bar with formatTime() (MM:SS / H:MM:SS)
   - SkipBack/SkipForward (±10s, disabled with disableSeek)
   - Play/Pause toggle (h-14 w-14)
   - Volume slider [0..1, step 0.05] + mute toggle (3-state icon)
   - Stop button (red pill)
   - polls GET /api/cast/sessions/:id at 1000ms

Player.tsx (Phase 3) → adds:
   - fullscreen button (visible only when not casting)
   - 'F' / 'f' keyboard shortcut (skipped on input fields)
   - listens for `fullscreenchange` on document
   - calls videoRef.current.requestFullscreen().catch(() => {})

App.tsx → adds:
   - typeFilter state ∈ {"all" | "movie" | "series"}
   - FilterPill row (only when debounced.length >= 3)
   - typeFilter passed as 3rd item in queryKey + to api.search()
```

## Key files

| Path | Role |
|---|---|
| `apps/web/src/components/CastControls.tsx` | refined Now Playing panel (added in/expanded by Phase 7) |
| `apps/web/src/components/Player.tsx` | fullscreen button, 'F' shortcut, fullscreenchange listener |
| `apps/web/src/components/CastBar.tsx` | unchanged for controls — still owns device picker + play mutation |
| `apps/web/src/App.tsx` | typeFilter state + FilterPill row |
| `apps/web/src/lib/api.ts` | passes type to `/api/search?type=…` |
| `apps/server/src/services/cast.ts` | adds mute/unmute control dispatch + status fields (volumeLevel, muted) |
| `apps/server/src/routes/cast.ts` | extends `VALID_ACTIONS` with mute/unmute |
| `apps/server/src/routes/movies.ts` | dispatches by type — `safeSearch(query, "movie")` or `safeSearch(query, "series")` |
| `apps/server/src/services/omdb.ts` | already supported `type` param; Phase 7 reuses it |
| `packages/shared/src/index.ts` | `CastSessionStatus` (currentTime, duration, volumeLevel, muted), `CastAction` extended |

## Refined cast controls

- **Seek bar.** `<input type="range" min={0} max={duration} step={1} value={Math.floor(currentTime)}>`. `onChange` fires `ctrl.mutate({ action: "seek", value })` immediately on every move. Time text: `formatTime()` chooses MM:SS or H:MM:SS based on duration.
- **Disabled state.** `disableSeek || duration === 0` → seek bar greyed, skip buttons greyed, "seek disabled (transcoding)" hint when `disableSeek` was passed by Player.
- **Volume.** Slider bound to `muted ? 0 : volumeLevel`. Mute icon flips between full/low/muted by threshold (0.5).
- **Stop.** Red button → `control("stop")` → server clears session → UI returns to `<video>` mode.
- **Polling.** `useQuery({ queryKey: ["cast-session", id], refetchInterval: 1000 })`. Status reflection lags by ≤1s; user actions are sent fire-and-forget.
- **Server-side dispatch.** `cast.ts.control()` clamps volume to `[0, 1]`. Mute/unmute call into castv2's `setVolume({ muted: true/false })`.

## Fullscreen

- **Element.** `videoRef.current` (the `<video>`). Cast mode hides the button entirely.
- **API.** `requestFullscreen()` only — no vendor prefixes (`webkit*`, `moz*`). Modern browser baseline (Chromium 71+, Firefox 64+, Safari 16+).
- **Failure.** `.catch(() => {})` — silent on permission deny / unsupported.
- **State tracking.** `document.addEventListener("fullscreenchange", ...)`; reads `document.fullscreenElement` to derive UI state.
- **Keyboard.** 'F' or 'f' on `keydown`. Skipped if `event.target instanceof HTMLInputElement` to avoid hijacking the search bar.

## Type filter

- **State.** `typeFilter ∈ {"all", "movie", "series"}` in `App.tsx`.
- **UI.** Three FilterPill buttons above ResultsGrid; visible only when `debounced.trim().length >= 3`. Active pill: amber background.
- **Wire-up.** `useQuery({ queryKey: ["search", debounced, typeFilter] })` — typeFilter is part of the cache key, so changing it re-fetches.
- **Client→server.** `api.search(q, typeFilter === "all" ? undefined : typeFilter)` → `GET /api/search?q=…&type=…`.
- **Server.** `routes/movies.ts` dispatches: `"movie"` or `"series"` → single-pass `safeSearch(q, type)`; `undefined` → parallel + interleave (Phase 1 behaviour).

## Cross-cutting

- **`CastSessionStatus`** gains `volumeLevel`, `muted` to support the slider + mute UI.
- **`CastAction`** union becomes `"play" | "pause" | "stop" | "seek" | "volume" | "mute" | "unmute"`.
- **`disableSeek` prop** is passed from Player → CastControls based on whether smooth playback (transcoding, Phase 6) is active.

## Tests

None for the Phase 7 surface. OMDb adapter changes (single-pass when type set) are not covered. Fullscreen + cast-control polling are exercised via manual testing on real hardware.

---

## Gotchas

- **No vendor prefixes for fullscreen.** Older browsers and some embedded WebViews (older Electron, some Smart TVs) won't support `requestFullscreen` without `webkit*`. Add fallbacks if you ever embed.
- **Mobile fullscreen quirks.** iOS Safari forces native player chrome in fullscreen — our overlay disappears. Acceptable for a desktop-first app, surprising on mobile.
- **1s polling lag on volume / seek.** Drag the seek bar, server gets the seek immediately, but the slider snaps back to the old value until the next poll lands. Could feel laggy.
- **`F` shortcut hijack risk.** Skipped only when `event.target` is `HTMLInputElement`. Textareas, contenteditable, and shadcn dialogs won't be excluded.
- **No keyboard shortcuts for cast controls.** Space/play, arrow seek, etc. — not wired.
- **Type filter pills only appear at ≥3 chars.** Same threshold as search. Changing the threshold means changing both.

## Future enhancements

### High priority
- [ ] Optimistic UI for seek/volume — update slider immediately, reconcile on next poll
- [ ] WebSocket push for cast state to eliminate the 1s lag (infrastructure already in place)

### Medium priority
- [ ] Keyboard shortcuts: Space (play/pause), ArrowLeft/Right (seek ±5s), M (mute)
- [ ] Vendor-prefix fullscreen API for older WebViews
- [ ] Aria labels + roles on the seek/volume sliders
- [ ] Show cast device name in the Now Playing panel

### Low priority
- [ ] Custom fullscreen overlay with our own controls (replaces native browser HUD)
- [ ] Mobile-first cast controls (taller targets, horizontal layout)
- [ ] Picture-in-picture (`requestPictureInPicture`)
