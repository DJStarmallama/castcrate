# player-buffer-ux — Context

**Last updated:** 2026-08-08
**Status:** Spec / not started (quick-fix overlay landed as commit `a764daa`) — **new production bugs found 2026-08-08 during castcrate/media-mac-deploy P5.7, see "Bugs found in production testing" at bottom of this file**

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
