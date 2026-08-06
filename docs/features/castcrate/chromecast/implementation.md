# Feature: chromecast — Phase 3 (Retrospective)

**Status:** Implemented
**Documented:** 2026-05-09
**Phase:** 3 — refined further by Phase 7

## Executive summary

mDNS discovery + Cast V2 session that loads the same `/stream/:infoHash` URL onto a Chromecast on the LAN. Devices are browsed continuously via `bonjour-service`, the laptop's outbound LAN IP is computed at play-time so the Chromecast can actually reach the URL (not `localhost`), and a single active session is tracked in memory. Status updates surface to the UI via 1s polling, not WebSocket — `@fastify/websocket` is registered but unused for cast state. Phase 7 layered on the refined transport controls and fullscreen.

---

## Architecture

```
Chromecast ◀── mDNS announces ──▶ bonjour-service ──▶ services/discovery.ts
                                                          │
                                            Map<id, CastDevice> in memory
                                                          │
GET /api/cast/devices ◀───────────────────────────────────┘

POST /api/cast/play { deviceId, streamPath, title, posterUrl?, subtitlePath? }
                │
                ▼
       lib/network.ts.getLanIp()  ──▶  build http://<LAN_IP>:3000/stream/...
                │
                ▼
       services/cast.ts ──▶ new Client() ──▶ DefaultMediaReceiver.load(media)
                │
                ▼
       Session { sessionId, deviceId, status, currentTime, duration, volume, muted }

POST /api/cast/control { sessionId, action, value? }
GET  /api/cast/sessions/:sessionId  (polled at 1000ms)
```

## Key files

| Path | Role |
|---|---|
| `apps/server/src/services/discovery.ts` | `_googlecast._tcp` browser, IPv4 extraction, `Map<id, CastDevice>` cache, `onDevicesChanged` listener |
| `apps/server/src/services/cast.ts` | castv2-client wrapper — single-session, status listener, control dispatch |
| `apps/server/src/lib/network.ts` | `getLanIp()` — first non-internal IPv4 interface |
| `apps/server/src/routes/cast.ts` | `/api/cast/devices`, `/api/cast/play`, `/api/cast/control`, `/api/cast/sessions/:sessionId` |
| `apps/server/src/index.ts` | `startDiscovery()` on boot; `onClose` → `stopDiscovery()` + cast shutdown |
| `apps/web/src/components/CastBar.tsx` | device picker dropdown, polls devices at 5000ms, mutates `/api/cast/play` |
| `apps/web/src/components/CastControls.tsx` | Now Playing panel, polls session at 1000ms |
| `apps/web/src/components/Player.tsx` | toggles between local `<video>` and CastControls based on `castSessionId` |
| `packages/shared/src/index.ts` | `CastDevice`, `CastSession`, `CastSessionStatus`, `CastAction` |

## Discovery (`services/discovery.ts`)

- **Service type.** `_googlecast._tcp` (the library appends `.local`).
- **Lifecycle.** Single global `Bonjour()` instance. `up`/`down` events mutate the device cache.
- **Device extraction (`deviceFromService`):**
  - IP — first match of `/^\d+\.\d+\.\d+\.\d+$/` in `svc.addresses`, fallback `svc.referer?.address`. **IPv4 only.**
  - Name — `svc.txt.fn` → `svc.name`.
  - Id — `svc.txt.id` → `svc.fqdn`.
  - Port — `svc.port` (typically 8008, used as-is).
- **Refresh strategy.** Continuous; mDNS is push-based. No polling interval. `emit()` notifies subscribers (currently only registered, not used for WS push yet).
- **Shutdown.** `stopDiscovery()` is wired to `app.addHook("onClose")` — destroys the Bonjour instance and clears the map.

## Cast session (`services/cast.ts`)

- **One session at a time.** `sessions: Map<sessionId, Session>` is keyed by UUID, but logic assumes a single concurrent cast.
- **Construction.** Dynamic `import("castv2-client")` (CommonJS interop), then `new Client()`, `client.connect(host, port)`, `client.launch(DefaultMediaReceiver)`.
- **Status listener.** `player.on("status", ...)` mutates the in-memory session in place (`currentTime`, `duration`, `volume.level`, `muted`). No pub/sub — UI re-reads via the `GET /sessions/:id` endpoint.
- **Close listener.** `player.on("close", ...)` marks `status = "stopped"` and removes the session.
- **Controls.** `play | pause | stop | seek | volume | mute | unmute` (mute/unmute added in Phase 7). Volume value clamped to `[0, 1]`.
- **Subtitles.** Tracks array passed at load time; `activeTrackIds: [1]` enables the first track. No runtime track switching (Cast SDK supports it but we don't surface it).

## Stream URL construction

- `getLanIp()` iterates `os.networkInterfaces()` and returns the first IPv4 with `family === "IPv4"` and `!iface.internal`. Returns `null` on no eligible interface (route returns 500).
- URL format: `http://${ip}:${config.port}${streamPath}`.
- Subtitle URLs use the same prefix.
- Server **must** bind `0.0.0.0` for the Chromecast to reach the URL — covered by the scaffold phase.

## Routes (`routes/cast.ts`)

| Method | Path | Body / Params | Returns |
|---|---|---|---|
| GET | `/api/cast/devices` | – | `{ devices: CastDevice[] }` |
| POST | `/api/cast/play` | `{ deviceId, streamPath, title, posterUrl?, contentType?, subtitlePath?, subtitleLanguage?, subtitleName? }` | `{ sessionId, streamUrl }` |
| POST | `/api/cast/control` | `{ sessionId, action, value? }` | `{ ok: true }` |
| GET | `/api/cast/sessions/:sessionId` | – | `CastSessionStatus` or 404 |

Validation is hand-rolled (no JSON Schema): missing `deviceId`/`streamPath`/`title` → 400; invalid action → 400; device-not-found → 404; LAN IP unavailable → 500.

## Web side

- **CastBar.** Polls devices at 5000ms; replaces the dropdown with a green "Stop casting" button when a session is active. Computes `streamUrl` from the active stream + selected subtitle, calls `POST /api/cast/play`, lifts `sessionId` to `Player`.
- **CastControls.** Shown when `castSessionId !== null`. Polls `/api/cast/sessions/:sessionId` at 1000ms; transport controls fire mutations against `/api/cast/control` (fire-and-forget; reflection arrives via the next poll).
- **Player.** Owns the toggle between local `<video>` and CastControls. Stop button explicitly calls `castControl(..., "stop")` before unmount.

## WebSocket

`@fastify/websocket` is registered (`/ws` route exists) but **carries no traffic for cast state in Phase 3**. The plan's "WebSocket channel for progress + cast status push" is implemented as polling instead. The infrastructure to push (`onDevicesChanged` in discovery.ts) is wired; subscribers just aren't.

## Tests

None for cast/discovery — it's the integration-risk surface and per `docs/technical-design.md` §8 we don't mock these libs. Manual end-to-end on real hardware is the floor.

---

## Gotchas

- **Single-session model.** No mutex; concurrent `play` calls clobber the previous session in memory. Acceptable for one user, fragile under abuse.
- **Session never times out.** If the Chromecast loses power or the device crashes, the session entry stays in the map until manually stopped or server restart. No heartbeat.
- **IPv6 not supported.** `getLanIp()` filters to IPv4 only. Most home networks are dual-stack but Chromecasts advertise IPv4 — fine in practice.
- **Subtitle track switching is one-shot.** Set at load time; can't change without stop+replay.
- **Polling everywhere.** 5s for device list, 1s for session status. WebSocket would be cheaper.
- **`svc.port` is trusted.** Whatever the device announced is used as-is. Standard is 8008 — no validation.
- **Cast V2 client is CommonJS.** Loaded via dynamic `import` to navigate ESM interop; do not switch to a static import without re-validating.
- **macOS firewall prompts on first run.** Required for incoming Cast control connections; document in README.

## Future enhancements

### High priority
- [ ] Add session heartbeat — drop sessions whose status hasn't ticked in N seconds.
- [ ] Wire WebSocket push for device list + session status (replace polling).

### Medium priority
- [ ] Multi-session support (different rooms / handoff).
- [ ] Runtime subtitle track switching via `Media.editTracksInfo`.
- [ ] Surface friendly errors when the receiver rejects the load (codec mismatch).

### Low priority
- [ ] IPv6 support in `getLanIp()`.
- [ ] Configurable mDNS service type (for Cast Audio, etc.).
