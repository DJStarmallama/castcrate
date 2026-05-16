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

## Out of scope (future)

- Buffered-range overlay on the timeline scrubber.
- Automatic fall-through to next result on dead swarm.
- Smart prefetch / look-ahead.
- Pre-warm next-episode in a series.
