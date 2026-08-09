# player-buffer-ux — Tasks

**Last updated:** 2026-08-09
**Progress:** Quick-fix overlay shipped (commit `a764daa`); Phase 6 (Overlay layering fix pass): 5 of 9 done + 2 N/A. **Phase 2 prereq landed (2026-08-09): `useBufferState()` reducer extraction — the informal state machine that was scattered across `Player.tsx` (`hasPlayedOnce` + `videoBuffering` + `stalled`) is now a single pure reducer in `apps/web/src/hooks/useBufferState.ts`.** Behavior-preserving; opens the door for the Phase 2 dead-swarm CTA to add transitions without hunting through the render blob. Phases 1, 3–5 still pending. 6.8 manual verification still pending on the media Mac (needs box + browser).

## Phase 0 — Quick fix (DONE)

- [x] Buffering overlay on video element during initial peer warmup + mid-play `waiting` events.
- [x] Status polling drops from 10s → 1.5s during buffering, restores to 10s when stable.
- [x] Skips entirely for Stremio HTTP-shape sessions.

## Phase 1 — Per-play buffer preset

- [ ] `services/torrent.ts` — `startTorrent(input, opts: { fileIdx?, bufferTarget? })`. When set, override the global `bufferPercent` for this session's readiness gate.
- [ ] `routes/torrents.ts` — `/api/torrent/start` body accepts optional `bufferTarget: number` (0..1).
- [ ] `apps/web/src/lib/api.ts` — `startTorrent` body accepts optional `bufferTarget`.
- [ ] New `PreplayBufferDialog.tsx` — three preset radios (Quick 1% / Smooth 5% / Patient 15%) + "remember this choice" + Start / Cancel.
- [ ] `App.tsx` — when `localStorage.askBufferBeforePlay === "1"` AND result is not stremio HTTP-shape, intercept `start.mutate` to show the dialog first.

## Phase 2 — Polished BufferingOverlay states

- [x] **P2.0 (prereq — Epic Review 2026-08-09)** Extract explicit `useBufferState()` reducer covering the initial-buffer / mid-play / stalled / playing / error transitions. Consolidates the informal `hasPlayedOnce` + `videoBuffering` + `stalled` triad that was scattered across `Player.tsx`. Behavior-preserving; makes Phase 2 additions readable in one file. → `apps/web/src/hooks/useBufferState.ts`; Player.tsx refactored to dispatch on `<video>` events + swarm stall detection.
- [ ] Replace quick-fix overlay with three-state component (initial / mid-play underrun / dead swarm).
- [ ] Dead-swarm detection: `peers === 0 && elapsed > DEAD_SWARM_THRESHOLD_MS` OR `progress hasn't moved in 30s`.
- [ ] Dead-swarm CTA: "Pick another" closes Player back to TorrentPicker; "Keep waiting" dismisses overlay.
- [ ] Export `DEAD_SWARM_THRESHOLD_MS` from `services/torrent.ts` for client + server alignment. (Client-side constant already lives in `hooks/useBufferState.ts` at 10_000 ms — bump to 30_000 when the server export lands and the CTA is wired.)
- [ ] Mid-play overlay (state 2) becomes more compact than initial (state 1) — less screen real estate.
- [ ] Inline help text: "Streaming starts once enough of the file is downloaded ahead of the playhead."

## Phase 3 — Settings UI

- [ ] New "Playback" section in `Settings.tsx`: Default buffer radio (Quick / Smooth / Patient) wired to `RuntimeSettings.bufferPercent`.
- [ ] "Ask before each play" checkbox wired to `localStorage.askBufferBeforePlay`.

## Phase 4 — Tests

- [ ] `Player.test.tsx` — initial-buffer overlay renders.
- [ ] `Player.test.tsx` — `waiting` event triggers state 2.
- [ ] `Player.test.tsx` — dead-swarm threshold triggers state 3 with CTAs.
- [ ] `Player.test.tsx` — Stremio HTTP session skips all overlays.
- [ ] Server: `startTorrent` honours `bufferTarget` over global default.

## Phase 5 — Docs

- [ ] README — short "Buffering" paragraph: explains the three presets, what dead-swarm means, that Real-Debrid skips this entirely.

## Phase 6 — Overlay layering fix pass (added 2026-08-08; fixes the P5.7-found bugs)

Root cause: video element + controls layer + popovers aren't in a clean stacking context. Adopt the Jellyfin-inspired pattern documented in `implementation.md` → "Overlay layering fix pass" (portal + z-index + pointer-events). Reimplement — no code copy (Jellyfin is GPLv2, we borrow architecture only).

- [x] **6.1** Add `<div id="overlay-root"></div>` to `apps/web/index.html` after the main app root; document its role.
- [~] **6.2** ~~Introduce `.player-root` positioned wrapper in `Player.tsx` with an internal `.controls-layer`; move the buffering overlay and control bar inside it; ensure the `<video>` has no ad-hoc `z-index`.~~ **N/A** — Player uses native `<video controls>` at the bottom of the video plus a top HEADER for app-level controls (Cast, Subtitles, File picker, Fullscreen, Close). There is no custom overlay control bar to house in a `.controls-layer`. The three production bugs closed without this restructure. If custom overlay controls get built later (Phase 2's dead-swarm CTAs are a candidate), revisit.
- [~] **6.3** ~~Encode z-index + `pointer-events` rules in styles~~ **N/A** for the same reason as 6.2. Existing `pointer-events-none` on the buffering overlay backdrop is retained.
- [x] **6.4** Install `@radix-ui/react-popover` (or use existing shadcn `<Popover>` if already wired) — audit `package.json` first before adding a dep. → Added `@radix-ui/react-popover` (no shadcn wired in the repo).
- [x] **6.5** Rewrite `CastButton` to render its device picker via a portaled `<Popover>` targeting `#overlay-root`, z-index 100. Trigger sits in the control bar. → `CastBar.tsx` rewritten with `Popover.Root` + `Popover.Portal(container=#overlay-root)`.
- [x] **6.6** Rewrite `SubtitleMenu` (or equivalent controls-bar CC/subtitle picker) with the same portaled `<Popover>` pattern. → `SubtitlePicker.tsx` rewritten to match.
- [x] **6.7** Fix `BufferingOverlay` dismiss (bug #1). Root cause: the overlay predicate is `videoBuffering || !hasPlayedOnce`, but `hasPlayedOnce` only set on the `playing` event — which never fires when the browser blocks autoplay (Chrome default). Fix: also set `hasPlayedOnce=true` on `canplay`. Overlay was already conditional-render (not opacity), so unmount is correct once the predicate flips.
- [ ] **6.8** Manual verification checklist (matches "Verification" in implementation.md):
  - Play a title → buffer bar disappears within ~500 ms of first frame.
  - Cast picker opens over video, is clickable, dismisses on outside-click, keyboard-navigable.
  - Subtitle picker: same three checks.
  - Dead-swarm CTA (state 3) still triggers on a stalled torrent and its buttons work.
  - Regression: click-to-pause on the video area still works (control layer is `pointer-events: none` in the video middle area).
- [ ] **6.9** Update player component tests: add assertions for overlay dismiss + portal presence for the two pickers.

**Acceptance:** the three production-testing bugs (buffer-bar-won't-dismiss, cast-button-hidden, captions-button-hidden) are closed; deploy runbook `castcrate/media-mac-deploy` can complete its P6.4 cast test unblocked.

## Future enhancements (low priority)

- [ ] Buffered-range visualisation on the timeline scrubber.
- [ ] Auto-fall-through to next result on dead swarm (with a setting opt-in).
- [ ] Pre-warm next episode in a series.
- [ ] Show per-peer transfer rates in an expandable panel.
