# chromecast — Context

**Last updated:** 2026-08-09
**Status:** Implemented (retrospective doc)
**Refined by:** Phase 7 (cast-controls), heartbeat pass (2026-08-09)

## Status

- mDNS discovery + Cast V2 session both work
- Single active session at a time
- Status reflected via WS push (`cast:status`) with 10s poll safety-net
- Session heartbeat wired: 30s `getStatus` probe, 5s per-probe timeout, 2 consecutive failures → `status = "disconnected"` + `cast:disconnected` WS event
- No automated tests (per technical-design.md §8: integration risk, hardware-dependent)

## Key files

- `apps/server/src/services/discovery.ts` — bonjour-service, device map
- `apps/server/src/services/cast.ts` — castv2-client wrapper, single session
- `apps/server/src/lib/network.ts` — `getLanIp()`
- `apps/server/src/routes/cast.ts` — devices, play, control, sessions endpoints
- `apps/web/src/components/CastBar.tsx`, `CastControls.tsx`, `Player.tsx`
- `apps/server/src/index.ts` — `startDiscovery()` at boot, `onClose` shutdown

## Decisions

- **Stream URL must use LAN IP, not `localhost`.** Chromecast fetches over the network — `getLanIp()` picks the first non-internal IPv4 interface.
- **Single session in memory.** No persistence; if the server restarts, casts are lost. Fine for the local-only model.
- **WebSocket push for cast state, polling as safety-net.** `services/events.ts` broadcasts `cast:status`, `cast:closed`, and (2026-08-09) `cast:disconnected` events. The web `CastControls` still runs a slow 10s poll as a fallback if the WS drops. Freezes to `false` once `status === "disconnected"` — a dead receiver returns 404 on subsequent stops if we deleted the session, so we intentionally keep the map entry until the client issues stop.
- **Heartbeat probe: `player.getStatus`, 30s interval, 5s per-probe timeout, 2 failures = disconnected.** Chose `getStatus` over TCP-connection-state (which is meaningless with a hung socket) and over castv2's built-in heartbeat controller (which only pings the low-level transport, not the receiver app). A real GET_STATUS round-trip is the only proof the DefaultMediaReceiver is alive.
- **`bonjour-service` over `mdns`.** Pure-JS; no native bindings; cleaner shutdown story.
- **CastV2 default receiver.** No custom receiver app — the Default Media Receiver handles HTTP video + WebVTT subtitles.

## Gotchas

- **Disconnected sessions linger in the map on purpose.** `markDisconnected` sets `status="disconnected"` but does NOT delete the map entry — this way `GET /api/cast/sessions/:id` keeps returning the flipped state and the UI can render its banner. The entry is finally removed when the client issues `POST /api/cast/control { action: "stop" }`, which short-circuits into local cleanup for disconnected sessions (the underlying TCP socket is dead — no round-trip to attempt).
- **Heartbeat uses `player.getStatus` wrapped in a manual 5s Promise timeout.** castv2-client's `request/response.js` has no timeout of its own; if we didn't wrap, a dead receiver would hang the probe callback forever and the failure counter would never advance. Do not remove the `setTimeout` guard in `probeOnce`.
- **Any inbound `player.on("status")` resets `heartbeatFailures` to 0.** Proof-of-life is proof-of-life regardless of source. Also prevents a rare false positive where one probe times out on a slow receiver but the status stream is still ticking.
- **The `status` event handler refuses to overwrite `"disconnected"`.** A late-arriving status message from a briefly-reconnected receiver shouldn't resurrect a session we've already declared dead — the UI would rubber-band.
- **Subtitle track switching is load-only.** Stop + replay to change tracks.
- **`getLanIp()` is IPv4-only.** Home networks are typically dual-stack; Chromecasts announce IPv4 anyway.
- **macOS firewall prompts** for incoming cast-control connections on first run. README should mention.
- **Single-session race.** Two simultaneous `POST /api/cast/play` calls will both succeed and clobber each other. Add a mutex or rejection if it ever matters.
- **`@fastify/websocket` is now actively carrying cast events.** `/ws` broadcasts `torrent:list`, `cast:status`, `cast:closed`, and `cast:disconnected`. See `apps/web/src/hooks/useWsBridge.ts` for the client subscription.

## Session notes

### 2026-08-09 — Session heartbeat + WS disconnect event

Fixed the "powered-off Chromecast leaves a zombie session" bug called out in the epic's Tech Debt list. Every active session now runs a 30s `player.getStatus` probe (wrapped in a manual 5s Promise timeout because castv2-client's request/response controller has no timeout of its own). After 2 consecutive failures (~60s dead), the session flips to a new `"disconnected"` state, broadcasts a `cast:disconnected` WS event with `{ sessionId, deviceName }`, tears down the local client, and stops probing.

- Shared type: added `"disconnected"` to `CastSessionState` union (breaks any exhaustive switch — grep found none in the current codebase). Also added `deviceName: string` to `CastSessionStatus` so the client banner can name the device.
- Web: `CastControls.tsx` shows an amber banner when `status === "disconnected"`, disables transport/volume, keeps the Stop button working (the server short-circuits stop for disconnected sessions into local cleanup — no round-trip needed). Polling is frozen (`refetchInterval` returns `false`) once disconnected.
- WS: added `cast:disconnected` message shape to `useWsBridge.ts`. The bridge also merges into the cache key so the UI flips even if the immediate follow-up `cast:status` message is dropped.
- Shutdown: `shutdownCast()` now clears heartbeat intervals before closing clients. Heartbeat timers are also `unref`'d, so they wouldn't hold the loop open, but explicit teardown is cleaner and doesn't interact with the 5s/8s bounded-shutdown race.
- Verified: mocked probe state machine passes 8/8 checks (3 successes stay OK, 2 fails → disconnected, 1 fail + 1 success resets counter, hung probe times out within tolerance). Real Chromecast test still needed — see report.
