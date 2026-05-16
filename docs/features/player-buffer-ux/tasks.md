# player-buffer-ux — Tasks

**Last updated:** 2026-05-16
**Progress:** Quick-fix overlay shipped (commit `a764daa`); rest pending.

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

- [ ] Replace quick-fix overlay with three-state component (initial / mid-play underrun / dead swarm).
- [ ] Dead-swarm detection: `peers === 0 && elapsed > DEAD_SWARM_THRESHOLD_MS` OR `progress hasn't moved in 30s`.
- [ ] Dead-swarm CTA: "Pick another" closes Player back to TorrentPicker; "Keep waiting" dismisses overlay.
- [ ] Export `DEAD_SWARM_THRESHOLD_MS` from `services/torrent.ts` for client + server alignment.
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

## Future enhancements (low priority)

- [ ] Buffered-range visualisation on the timeline scrubber.
- [ ] Auto-fall-through to next result on dead swarm (with a setting opt-in).
- [ ] Pre-warm next episode in a series.
- [ ] Show per-peer transfer rates in an expandable panel.
