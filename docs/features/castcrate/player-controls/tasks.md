# player-controls — Tasks

## Phase 1 — Foundation

- [x] 1.1 Add `formatTime()` to `apps/web/src/lib/format.ts` (extract from `CastControls`)
- [x] 1.2 Rewire `CastControls` to import the shared `formatTime`
- [x] 1.3 Add `useAutoHide` hook at `apps/web/src/hooks/useAutoHide.ts`

## Phase 2 — Custom control bar

- [x] 2.1 Create `apps/web/src/components/PlayerControls.tsx` scaffold
- [x] 2.2 Seek row: current time / buffered ranges / range input / duration
- [x] 2.3 Seek row: hover preview time chip
- [x] 2.4 Seek row: optimistic drag → commit on release
- [x] 2.5 Transport row: play/pause + ±10s skip buttons
- [x] 2.6 Transport row: volume icon + slider + mute toggle
- [x] 2.7 Transport row: title / subtitle context centered
- [x] 2.8 Right: SubtitlePicker integration + open-flag callback
- [x] 2.9 Right: CastBar integration + open-flag callback
- [x] 2.10 Right: fullscreen toggle button
- [x] 2.11 RAF loop reading `<video>` state → props consumed by seek + volume + play state

## Phase 3 — Auto-hide + cursor

- [x] 3.1 Hook `useAutoHide` into `Player.tsx` around the video container
- [x] 3.2 `onMouseMove` → `showNow()`; bar hover → `cancelHide`; mouse leave bar → `scheduleHide`
- [x] 3.3 Never hide while paused OR while a subtitle/cast popover is open OR while buffering
- [x] 3.4 Add `cursor-none` class when bar is hidden

## Phase 4 — Keyboard shortcuts

- [x] 4.1 `Space` — toggle play/pause (guard `event.repeat`)
- [x] 4.2 `ArrowLeft` / `ArrowRight` — seek ±10s (Shift = ±30s)
- [x] 4.3 `ArrowUp` / `ArrowDown` — volume ±0.05
- [x] 4.4 `M` — mute toggle
- [x] 4.5 `C` — subtitle menu open (imperative ref pattern)
- [x] 4.6 All shortcuts: guard on editable target; call `showNow()` on hit
- [x] 4.7 Existing `F` shortcut retained (fullscreen)

## Phase 5 — Video-element wiring

- [x] 5.1 Remove `controls` attribute from `<video>` in `Player.tsx`
- [x] 5.2 Move SubtitlePicker / CastBar / fullscreen button out of header, pass into `PlayerControls`
- [x] 5.3 Add `onDoubleClick={toggleFullscreen}` on `<video>`
- [x] 5.4 Verify BufferingOverlay still layers above bar (pointer-events-none on outer preserved)

## Phase 6 — Quality

- [x] 6.1 Smooth ease transitions (Tailwind `transition-opacity duration-300`)
- [x] 6.2 Aria labels on all controls
- [x] 6.3 `pnpm --filter @castcrate/web typecheck` clean
- [x] 6.4 `pnpm --filter @castcrate/web lint` — no new violations
- [x] 6.5 `pnpm --filter @castcrate/web build` clean
- [ ] 6.6 Manual test (deferred to same session that closes deploy runbook — needs a torrent + browser)
