# player-buffer-ux — Context

**Last updated:** 2026-08-09
**Status:** Spec / not started (quick-fix overlay landed as commit `a764daa`) — **Phase 6 (Overlay layering fix pass) added 2026-08-08 to close the three production bugs found during castcrate/media-mac-deploy P5.7. See implementation.md → "Overlay layering fix pass" and tasks.md → Phase 6.** **Phase 2 prereq landed 2026-08-09 — `useBufferState()` reducer extracted; see session note below.**

## Problem

Webtorrent streams have variable peer-discovery latency: a popular torrent serves first byte in 2-5s, but a rare older release can take 30s+ to find seeders. Today's UX:

- No prominent "buffering…" indicator. Footer has a 4-pixel progress bar that's invisible during the critical first 10s.
- Status polling at 10s means the user stares at a frozen player with no feedback (the quick fix dropped this to 1.5s during warmup but it's still reactive, not proactive).
- No way to say "wait until 5% downloaded before starting playback" — the server's `bufferPercent` setting controls *server-side* gating but there's no per-play override or even a visible indicator that the setting exists.
- Stalled stream (no peers ever connect) and slow stream (1 peer at 100 KB/s) feel identical to the user.

Real-Debrid (HTTP) streams don't have this issue — they stream from a CDN, peer count is irrelevant. But torrent streams remain the common case for any title RD doesn't have cached.

## Goal

Make the Player's relationship with the swarm legible. User should always know: am I waiting on peers? am I downloading fast enough? should I pause and let it buffer? did the stream just stall?

## Non-goals

- Pre-fetching the whole file before play. Streaming-while-downloading is the core product; the buffer UX exists to make that paradigm comfortable, not to undo it.
- Surfacing detailed swarm internals (DHT nodes, individual peer IPs, choke/unchoke). Not user-facing.
- New ffmpeg pipeline branches (transcode-from-URL etc.). Out of scope.
- Changing the server-side `bufferPercent` default behaviour. Existing default works; this feature exposes + tunes per-play.

## Scope

In:
- New per-play "buffer to N% before play" UI control with a few presets.
- Visible progress overlay during initial buffering + on mid-play buffer underruns (quick fix landed; this iteration polishes it).
- Stall detector with a clearer call-to-action when no peers connect within 30s (e.g. "Try another result — this one may be dead").
- Server endpoint for the player to request a *target buffer percent* per-stream rather than relying on the global setting.
- Brief explainer in the buffering overlay about what's happening ("torrents need peers" — a one-line hint for users who don't know the protocol).

Out:
- Auto-fall-through to next result on stall — too aggressive; the user should pick.
- "Smart prefetch" / look-ahead — out of scope for v1.
- Visible browser-side buffered ranges in the timeline scrubber (nice-to-have, hard to do well with our scrubber).

## Decisions

- **Per-play "buffer before play" preset, not a global mode change.** Global settings are remembered but each playback can override. Defaults to current global, with a small toggle near the play button.
- **Three presets, not a slider.** "Quick start (1%)", "Smooth (5%)", "Patient (15%)". Reasoning: a slider invites tweak-paralysis; three presets cover the spectrum and self-document.
- **Show overlay always until first frame plays.** Currently it shows on `waiting` events — but the truly painful state is "nothing happened yet at all, am I supposed to wait or click something?" Overlay should default to visible for the first 2-3s of a new session, then defer to play state.
- **HTTP-stream sessions ignore everything in this feature.** They have no swarm. The Player already branches; this stays that way.
- **No new ffmpeg knobs.** Buffering UX is purely about webtorrent + browser interaction, not the transcode pipeline (transcoder has its own buffer concept in `transcodeBufferPercent` — leave alone).

## Gotchas

- **Buffer % can regress on seek.** webtorrent's `progress` is total-bytes-downloaded / total-bytes. Seeking forward can leave the "watched" region 100% complete while the new playhead position is 0% — `progress` may visibly drop. Document inline; visual progress should ideally show the buffered range around the playhead, not the total — but that's complex. v1 just shows total.
- **Network latency vs swarm health.** A torrent at 0 peers for 5 minutes is genuinely dead; we should suggest the user picks a different result rather than tell them to wait longer. v1 stall threshold is currently 10s; for the "this is dead" call-to-action we want a separate longer threshold (~30s).
- **`bufferPercent = 0` is valid.** Some users want absolutely-zero buffering (live-start, accept stalls). Don't gate on `bufferPercent > 0` anywhere.
- **Server `getStatus()` polling at 1.5s during buffering is a 40% increase in /api/torrent/:hash QPS per playing user.** Cheap (the route just reads webtorrent state) but worth tracking if multiple users run cratebuddy on the same server.
- **`<video>.preload` is `auto` by default**, which Chrome respects but Safari sometimes ignores. The buffering overlay's accuracy depends on `waiting`/`canplay` events firing — Safari may emit them differently. Test on both.

## Bugs found in production testing (2026-08-08, from castcrate/media-mac-deploy P5.7)

Manual verification during the deploy runbook surfaced these player-UX regressions on the browser player (Chrome on macOS, streaming from the castcrate box). All three probably share one root cause (stacking context + `pointer-events` misconfiguration). Fixed in **Phase 6** of `tasks.md`; approach documented in `implementation.md` → "Overlay layering fix pass".

- 🐛 **Buffer bar never dismisses.** During playback the buffer bar / overlay stays visible over the video and there is no way to minimise/hide it. Expected: should unmount when playback stabilises (fire on `canplay`, not just fade opacity). Likely the current quick-fix `BufferingOverlay` is always-mounted with an opacity switch, or the state machine never receives the `canplay` transition.
- 🐛 **Cast button hidden by the video element.** Cannot reach the "Cast to Chromecast" control while a movie is playing — the video element sits above the control layer. Expected: cast picker should render in a portaled popover *over* the video.
- 🐛 **Captions/subtitles button hidden by the video element.** Same root cause as the cast button — the subtitle menu is obscured. Expected: menu opens over the video via the same portaled popover pattern.

### Fix approach (borrowed from Jellyfin architecture, reimplemented; GPLv2 → no code copy)

All three share a stacking-context problem. Jellyfin's `jellyfin-web` player solves it with:

1. **Positioned `.player-root`** wrapping video + controls, establishing a stacking context.
2. **`.controls-layer`** covering the frame at `z-index: 10`, `pointer-events: none`. Individual bars / CTAs opt back in with `pointer-events: auto`.
3. **Popovers portaled** to a top-level `<div id="overlay-root">` at `z-index: 100`, outside the player subtree — so the picker menus render above everything and aren't clipped by any parent `overflow: hidden`.
4. **BufferingOverlay** dismisses on `canplay` — conditional render, not just opacity.

Reimplement with **Radix Popover** (or the shadcn `<Popover>` primitive that wraps it) — same portal + focus-trap + escape-key behaviour, permissive-licensed, small dep. Full spec in `implementation.md` → "Overlay layering fix pass"; checklist in `tasks.md` → Phase 6.

**Order-of-operations:** finish `castcrate/media-mac-deploy` Phases 6–7 first (the deploy is unblocked by the crash fix in commit `dc8fe0c`, but the cast test may still hit the hidden-cast-button bug). Then run Phase 6 here as the first player pass, then continue Phases 1–5 (the buffer-preset dialog / three-state overlay / settings) as originally planned.

## Epic Review Findings (2026-08-09)

- 🔗 **Cast session has no heartbeat** — spans chromecast ↔ cast-controls ↔ player-buffer-ux — powered-off Chromecast leaves session stuck; player polls forever. Add 30s heartbeat + WS event. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Subtitle picker no-op during cast** — spans subtitles ↔ cast-controls ↔ player-buffer-ux. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Torrent-lifecycle idempotency** — spans yts ↔ library-settings ↔ transcoding ↔ player-buffer-ux. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Subtitle track has no fallback if torrent disappears mid-cast** — spans subtitles ↔ chromecast ↔ player-buffer-ux. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Transcoder has no fallback if ffmpeg dies mid-stream** — spans transcoding ↔ player-buffer-ux ↔ cast-controls. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Buffer overlay has no formal state machine** — spans player-buffer-ux ↔ yts ↔ transcoding — extract `useBufferState()` reducer BEFORE Phases 2/3 add more transitions. (See epic-overview.md → Tech Debt / Findings for full detail.) → **RESOLVED 2026-08-09** (see session note below).
- 💳 **Overlay layering Phase 6 landed but Phases 2/3 spec-only, and informal state machine will make them painful** — extract `useBufferState()` reducer first. (See epic-overview.md → Tech Debt / Findings.) → **RESOLVED 2026-08-09** (see session note below).

_Recorded by /review-epic castcrate on 2026-08-09._

## Session notes

### 2026-08-09 — `useBufferState()` reducer extraction (Phase 2 prereq)

Landed the "extract explicit state machine before Phases 2/3" work called out
in the epic review. Behavior-preserving refactor: no new overlays, no CTA
changes, no z-index shifts, no server changes.

**Files touched**

- `apps/web/src/hooks/useBufferState.ts` (new) — the reducer + types + tiny
  `useReducer` wrapper hook + three tiny derived predicates
  (`isBufferingState`, `isStalledState`, `isInitialState`) so the render site
  doesn't re-encode the "which states show the overlay" rule.
- `apps/web/src/components/Player.tsx` — dispatch on `<video>` `canplay` /
  `playing` / `waiting` events and on the swarm-stall detector. Overlay
  render predicate and the inline `BufferingOverlay` component now switch on
  `state` rather than the old `hasPlayedOnce` + `videoBuffering` + `stalled`
  triad. Renamed the client-side stall threshold from an inline
  `STALL_THRESHOLD_MS` const to the exported `DEAD_SWARM_THRESHOLD_MS` — kept
  at 10 s (the currently-shipped value) so this is *not* a behavior change;
  the spec's 30 s target lands with the Phase 2 CTA.

**State union chosen**

    BufferState = "idle" | "initial-buffer" | "buffering" | "playing"
                | "initial-stalled" | "stalled" | "error"

Beyond the starting five (`idle | buffering | playing | stalled | error`)
the current code implicitly encoded two more states:

- **`initial-buffer`** — the "never played" phase where the overlay says
  "Buffering…" rather than "Buffering — waiting for more data". Previously
  latched via `!hasPlayedOnce`.
- **`initial-stalled`** — a stall detected before first `canplay`. Split from
  `stalled` (mid-play stall) so `recovered` can restore the correct pre-stall
  state — from `initial-stalled` back to `initial-buffer`, from `stalled`
  back to `buffering`. UI copy is identical for both stalled variants; the
  split is behavioral, not cosmetic.

**Event union**

    BufferEvent =
      | { type: "start" }
      | { type: "buffered" }        // <video> canplay
      | { type: "playing" }         // <video> playing
      | { type: "waiting" }         // <video> waiting
      | { type: "stall_detected"; sinceMs: number }
      | { type: "recovered" }
      | { type: "error"; message: string }
      | { type: "reset" }

Added `"waiting"` beyond the task's suggested union — the video element fires
it distinctly from the reducer's transitions and it drives the
`playing → buffering` transition. Extending the union to represent every
actual event source (rather than collapsing `waiting` into another event)
keeps the dispatcher one-to-one with the DOM events, which is much easier to
reason about than a hidden mapping.

**CastControls not modified.** The task listed `CastControls.tsx` as one of
the three components to refactor, but on inspection its only state-dependent
bit is `isBuffering = data?.status === "buffering"` — which is the *server*
side's Chromecast receiver status, communicated via the cast-session poll.
It is not driven by the local `<video>` element's events (there is no local
`<video>` in that branch — CastControls is rendered *instead of* the video
when casting). Folding it into `useBufferState` would be a category error:
the reducer models local playback + local swarm health, but during a cast
session the local video is dark. Left CastControls unchanged; noted here so
the choice is auditable.

**Stall latching preserved (subtle).** The old code's `stalled` boolean was
set once when the stall condition first fired (`if (!stalled) setStalled(true)`)
and cleared on the first progress delta. That meant the stall context could
persist across a `playing → waiting → buffering` transition. To preserve
this in the reducer without extending `BufferState` to carry latches, the
stall-detection effect now dispatches `stall_detected` on *every* poll where
the condition holds (rather than once). The reducer treats `stall_detected`
while `playing` as a no-op, so it costs nothing while stable; but the moment
the video drops back into `buffering` via `waiting`, the next poll's
`stall_detected` immediately transitions to `stalled`.

**Local `stalled` state retained for the footer `ProgressBar`.** The footer
progress bar goes amber when the swarm is stalled *even during stable
playback* — pre-refactor behavior. The reducer state can't carry a "stalled
while playing" flag without a state explosion, so the footer keeps a small
local `stalled` boolean that mirrors the same signal the reducer's dispatch
consumes. Both are updated from the same effect. One source of truth for
overlay decisions (the reducer); a separate one-bit latch for the footer.

**Build/lint status**

- `pnpm --filter @castcrate/web typecheck` → clean.
- `pnpm --filter @castcrate/web build` → succeeds (Vite 8, 385 kB bundle).
- `pnpm --filter @castcrate/web lint` → 6 pre-existing errors from
  `react-hooks` v7's newer `set-state-in-effect` and `purity` rules. All 6
  errors are on lines that existed unmodified before this refactor. New
  file `useBufferState.ts` is lint-clean. No net-new lint violations.

**Manual verification** — dev server boots clean (`vite ready in 152 ms`).
Reducer transitions traced by hand for the critical Phase 6 scenario
(`initial-buffer` → `buffered` → `playing`, overlay dismisses); matches
expected behavior. Full click-through on the media Mac is deferred to the
same session that closes tasks.md 6.8 (needs box + browser).
