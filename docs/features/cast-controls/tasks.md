# cast-controls — Tasks

**Last updated:** 2026-05-09
**Progress:** Implemented (retrospective)

## Original implementation (completed)

- [x] CastControls full Now Playing panel (seek, skip, play/pause, volume, mute, stop)
- [x] Seek bar with `formatTime` (MM:SS / H:MM:SS)
- [x] ±10s skip buttons (disabled when transcoding)
- [x] Volume slider [0..1, step 0.05] + 3-state mute icon
- [x] Stop button (red pill) → `control("stop")` → returns UI to local mode
- [x] Polling at 1000ms via TanStack Query
- [x] Server: mute/unmute actions added to VALID_ACTIONS + cast.ts dispatch
- [x] Status fields: volumeLevel, muted on `CastSessionStatus`
- [x] Player fullscreen button (visible only when not casting)
- [x] 'F'/'f' keyboard shortcut (skipped in HTMLInputElement)
- [x] `fullscreenchange` listener for state tracking
- [x] App-level typeFilter ∈ {"all", "movie", "series"}
- [x] FilterPill row (visible at ≥3 chars)
- [x] typeFilter as 3rd item in queryKey
- [x] Server: `routes/movies.ts` single-pass dispatch when type set

## Future enhancements

### High priority
- [ ] Optimistic UI for seek/volume (eliminate 1s slider snap-back)
- [ ] WebSocket push for cast state (drop polling)

### Medium priority
- [ ] Keyboard shortcuts: Space, ArrowLeft/Right, M
- [ ] Vendor-prefix fullscreen for older WebViews
- [ ] aria labels on sliders
- [ ] Cast device name in Now Playing panel

### Low priority
- [ ] Custom fullscreen overlay (replace native HUD)
- [ ] Mobile-first cast controls
- [ ] Picture-in-picture support
- [ ] Vitest for typeFilter dispatch in `routes/movies.ts`
