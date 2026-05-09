# chromecast — Context

**Last updated:** 2026-05-09
**Status:** Implemented (retrospective doc)
**Refined by:** Phase 7 (cast-controls)

## Status

- mDNS discovery + Cast V2 session both work
- Single active session at a time
- Status reflected via 1s polling — no WebSocket push for cast state
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
- **Polling for cast state.** WebSocket plugin is registered but unused for cast — polling at 1s is cheap enough for one user and one device.
- **`bonjour-service` over `mdns`.** Pure-JS; no native bindings; cleaner shutdown story.
- **CastV2 default receiver.** No custom receiver app — the Default Media Receiver handles HTTP video + WebVTT subtitles.

## Gotchas

- **No session heartbeat.** Powered-off Chromecast leaves a stale session entry until restart or manual stop.
- **Subtitle track switching is load-only.** Stop + replay to change tracks.
- **`getLanIp()` is IPv4-only.** Home networks are typically dual-stack; Chromecasts announce IPv4 anyway.
- **macOS firewall prompts** for incoming cast-control connections on first run. README should mention.
- **Single-session race.** Two simultaneous `POST /api/cast/play` calls will both succeed and clobber each other. Add a mutex or rejection if it ever matters.
- **`@fastify/websocket` is registered for `/ws` but unused.** Don't remove — Phase 4+ rely on the plugin being there.
