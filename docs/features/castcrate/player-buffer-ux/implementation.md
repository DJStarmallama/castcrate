# Feature: player-buffer-ux

**Status:** Spec
**Authored:** 2026-05-16
**Quick-fix already shipped:** commit `a764daa` added a basic buffering overlay + fast polling. This feature is the polished version.

## Executive summary

Webtorrent peer-discovery latency is inherently unpredictable. The polished player buffer UX gives the user (a) clear, real-time feedback on what the swarm is doing, (b) a per-play "wait for N% before starting" preset, and (c) a clear "this looks dead, pick another" signal when no peers connect within 30s. HTTP-stream sessions (Real-Debrid) are unaffected — they have no swarm.

---

## Architecture

```
RuntimeSettings
  └── bufferPercent: number             ← already exists — default for new plays

Per-play override (transient, not persisted)
  └── bufferTarget: 0.01 | 0.05 | 0.15  ← user picks before play; defaults to RuntimeSettings.bufferPercent / 100

POST /api/torrent/start
  └── body adds optional bufferTarget?: number   ← server passes to setMeta for the streaming gate

services/torrent.ts
  └── createReadStream waitForFirstByte already exists — extend the readiness gate to
      wait until torrent.downloaded / torrent.length >= bufferTarget before returning,
      or until per-play timeout.

Player
  ├── PreplayBufferDialog        ← appears between pick and start.mutate when user has presets toggled
  ├── BufferingOverlay (polished) ← unifies initial-buffer + mid-play stall + dead-swarm states
  └── footer ProgressBar         ← existing; kept as secondary at-a-glance indicator
```

## Key files (planned)

| Path | Role |
|---|---|
| `apps/server/src/routes/torrents.ts` | accept `bufferTarget` in `/api/torrent/start` body; pass to startTorrent |
| `apps/server/src/services/torrent.ts` | extend startTorrent to honour bufferTarget — wait for that fraction before resolving |
| `apps/server/src/services/torrent.ts` | new DEAD_SWARM_THRESHOLD_MS export (~30s) used by client logic |
| `apps/web/src/components/Player.tsx` | replace quick-fix overlay with polished BufferingOverlay component; show dead-swarm CTA when stalled > threshold |
| `apps/web/src/components/PreplayBufferDialog.tsx` | new — appears before start.mutate if user has the "ask" preference enabled |
| `apps/web/src/components/Settings.tsx` | new "Playback" section: default buffer preset (Quick / Smooth / Patient), toggle "ask each time" |
| `apps/web/src/lib/api.ts` | `startTorrent` accepts optional bufferTarget |

## Per-play buffer preset UI

When the user clicks Cast / Play on a torrent (magnet or torrentday-style — NOT stremio HTTP-shape):

If Settings has "ask before play" toggled on AND the result is not Real-Debrid HTTP-shape:

```
┌──────────────────────────────────────────────────┐
│ Start playback                                   │
│                                                  │
│ Choose how long to buffer before playing.        │
│                                                  │
│ ○ Quick start          1% buffered (~30s of video) │
│ ● Smooth                5% buffered (~3 min)       │  ← default from RuntimeSettings.bufferPercent
│ ○ Patient              15% buffered (~9 min)       │
│                                                  │
│ ☑ Remember this choice                           │
│                                                  │
│ [Cancel]                          [Start playing] │
└──────────────────────────────────────────────────┘
```

Default selection mirrors `RuntimeSettings.bufferPercent` mapped to the nearest preset.

If "ask before play" is OFF: skip dialog, use the default. (Default mode for most users.)

If `result.source === "stremio" && result.streamUrl`: skip dialog entirely — HTTP streams have no swarm to buffer.

## Polished BufferingOverlay

Replaces the quick-fix overlay. States:

1. **Initial buffer-up** (`!hasPlayedOnce && elapsed < dead-swarm threshold`)
   - Big spinner + "Buffering — N% of M% target"
   - Progress bar
   - "Connected to K peers · X MB/s"
   - Faint inline help: "Streaming starts once enough of the file is downloaded ahead of the playhead."

2. **Mid-play buffer underrun** (`hasPlayedOnce && videoBuffering`)
   - Small spinner + "Buffering — waiting for more data"
   - Compact, less intrusive (user has already been watching).
   - Auto-dismisses on `canplay` event.

3. **Dead swarm** (`peers === 0 && elapsed > 30s` OR `progress hasn't moved in 30s`)
   - No spinner.
   - Red/amber "No peers connected after 30s"
   - Subtext: "This torrent may be dead. Try a different result."
   - Buttons: **[Pick another]** (closes player, returns to picker) | **[Keep waiting]** (dismisses overlay; keeps trying).

4. **Stable playback** — overlay hidden.

## Server changes

**`/api/torrent/start`** body extended:

```ts
{
  // existing
  magnet?: string;
  torrentUrl?: string;
  streamUrl?: string;
  source?: string;
  title?: string;
  // …
  // new
  bufferTarget?: number;  // 0..1; if omitted, uses RuntimeSettings.bufferPercent / 100
}
```

When set: `startTorrent(input, { bufferTarget })`. In `services/torrent.ts`, the per-play target overrides the global on a single session. The torrent client gates the stream's first byte on `torrent.downloaded / torrent.length >= bufferTarget`.

**Stall detection threshold** (`DEAD_SWARM_THRESHOLD_MS = 30_000`) exported from `services/torrent.ts` so the client knows when to surface the dead-swarm CTA without hardcoding.

## Settings UI changes

New "Playback" section in `Settings.tsx`:

- **Default buffer**: radio group with Quick (1%) / Smooth (5%) / Patient (15%). Persists to `RuntimeSettings.bufferPercent`.
- **Ask before each play**: checkbox. Persists to a new client-only `localStorage` key `castcrate.askBufferBeforePlay = "1"`. Default OFF.

(Not server-stored because it's a UI preference, not a settings.json concern.)

## Quick-fix → polished migration

The quick fix's `BufferingOverlay` becomes the "initial buffer-up" state of the polished overlay. State 2 (mid-play underrun) is already wired via `videoBuffering`. New work is state 3 (dead swarm) + the per-play dialog + server gating.

## Tests

`Player.test.tsx` (if test infra exists for components):
- Initial-buffer state renders with correct progress.
- Mid-play `waiting` event triggers state 2 overlay.
- 0 peers + elapsed > 30s triggers state 3 (dead swarm CTA).
- Stremio HTTP-shape session (infoHash null) skips all overlay states.

Server:
- `startTorrent` honours `bufferTarget` over global setting.
- Existing global default behaviour unchanged when `bufferTarget` absent.

Manual smoke:
- A torrent with healthy seeders: shows state 1, auto-dismisses on first frame, no state 3.
- A genuinely dead torrent (try a niche 2002 release with 0 known seeders): state 1 → state 3 within ~30s, "Pick another" closes back to picker.
- Mid-play network throttle (DevTools → Slow 3G): state 2 fires after a few seconds.

## Overlay layering fix pass (added 2026-08-08, folded from Jellyfin borrow)

Production testing during `castcrate/media-mac-deploy` P5.7 surfaced three overlay bugs (see `context.md` → "Bugs found in production testing"). All three share a root cause: **the video element and the controls/overlay layer aren't in a clean stacking context**. The buffer bar covers subsequent playback state instead of yielding, and the cast + captions pickers can't be reached because the native `<video>` sits above the controls DOM.

**Adopted pattern (Jellyfin-inspired, reimplemented — Jellyfin is GPLv2, borrowing architecture only):**

```
<div class="player-root">                       z-index: 0    (positioned parent, creates stacking context)
  <video>                                       z-index: 0     (element)
  <div class="controls-layer">                  z-index: 10, pointer-events: none  (transparent overlay covering full frame)
    <div class="control-bar bottom">            pointer-events: auto              (only bar is interactive)
      <PlayPauseButton /> <ScrubBar /> <TimeReadout />
      <VolumeControl />  <SubtitleButton />   <CastButton />    <FullscreenButton />
    </div>
    <BufferingOverlay />                        pointer-events: none unless in state 3 (dead-swarm CTAs)
  </div>
</div>

<Portal target="#overlay-root">                 z-index: 100  (Radix Popover / shadcn — outside player DOM)
  <CastDevicePicker />
  <SubtitleTrackPicker />
</Portal>
```

Rules:

- **Video element**: `z-index: 0`. Do **not** set `position: absolute` on it without a wrapping stacking context, otherwise it escapes.
- **Controls layer**: sits over the video, fills the frame, `pointer-events: none` by default so mouse events fall through to the video for click-to-pause / double-click-to-fullscreen. Individual control containers (control bar, dead-swarm CTAs) flip to `pointer-events: auto`.
- **Popovers / pickers (cast, subtitles, quality)**: rendered via React portal to a top-level `<div id="overlay-root">` outside the player, `z-index: 100`. Use Radix Popover primitives (already shadcn-friendly). This is the single fix for bugs #2 and #3.
- **BufferingOverlay**: **must** dismiss when its state predicate is false. Bug #1 was the persistent bar — the existing quick-fix probably renders always-mounted with only opacity changes; convert to conditional render *or* wire the `canplay` event listener to actually reset the state machine.

Concrete file changes (updates to the "Key files" table above):

| Path | Additional role |
|---|---|
| `apps/web/src/components/Player.tsx` | wrap video + controls in a positioned `.player-root` with an internal `.controls-layer`; move the buffering overlay inside that layer; remove any `z-index` on the video itself |
| `apps/web/src/components/CastButton.tsx` (or wherever the cast trigger lives) | render its device picker via `@radix-ui/react-popover` (or shadcn `<Popover>`), portaled |
| `apps/web/src/components/SubtitleMenu.tsx` (or equivalent) | same — Radix portal, top-level overlay root |
| `apps/web/src/components/BufferingOverlay.tsx` | fix dismiss: conditional render, subscribe to `video.canplay` and clear state 2 explicitly |
| `apps/web/index.html` | add `<div id="overlay-root"></div>` after the main app root so portals land in a predictable place |
| new `apps/web/src/styles/player.css` (or tailwind classes inline) | encode the z-index + pointer-events rules above |

Dependencies to add if not already present: `@radix-ui/react-popover` (~small; shadcn-friendly). If shadcn is already wired in the repo, use `<Popover>` from the shadcn install.

### Verification

- Open a title, hit Play. The buffer bar appears; once playback starts, it disappears within ~500 ms of the `canplay` event.
- With playback going, click the cast icon in the control bar — device picker opens **over** the video, clickable, dismissable by clicking outside.
- Same for the subtitle picker.
- Regression: dead-swarm CTA still works (state 3), keyboard focus still traps correctly in each popover (Radix handles this).

## Out of scope (future)

- Buffered-range overlay on the timeline scrubber.
- Automatic fall-through to next result on dead swarm.
- Smart prefetch / look-ahead.
- Pre-warm next-episode in a series.
