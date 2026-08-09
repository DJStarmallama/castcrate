# chromecast — Tasks

**Last updated:** 2026-08-09
**Progress:** Implemented (retrospective) + heartbeat pass 2026-08-09

## Original implementation (completed)

- [x] mDNS browser via `bonjour-service` for `_googlecast._tcp`
- [x] Device cache (`Map<id, CastDevice>`) with up/down event handling
- [x] `lib/network.ts.getLanIp()` — first non-internal IPv4 interface
- [x] castv2-client session, single active at a time
- [x] DefaultMediaReceiver load with HTTP stream URL + LAN IP
- [x] Status listener wired to in-memory session object
- [x] Routes: `/api/cast/devices`, `/api/cast/play`, `/api/cast/control`, `/api/cast/sessions/:id`
- [x] Web: device picker, Now Playing panel, transport controls
- [x] Polling — 5s for device list, 1s for session status
- [x] `onClose` hook stops mDNS browser and cast sessions

## Future enhancements

### High priority
- [x] Session heartbeat — 30s `getStatus` probe, 5s per-probe timeout, 2 failures → `status = "disconnected"` + `cast:disconnected` WS event; web banner + Stop button; 10s poll frozen on disconnect. (2026-08-09)
- [x] WebSocket push for cast state — `cast:status`/`cast:closed` broadcast from `services/cast.ts` since Phase 6/7; `useWsBridge.ts` on the client. (Retained slow safety-net poll.)

### Medium priority
- [ ] Multi-session support (e.g. concurrent Chromecasts in different rooms)
- [ ] Runtime subtitle track switching via `Media.editTracksInfo`
- [ ] Friendly error UI when the receiver rejects load (codec mismatch)

### Low priority
- [ ] IPv6 support in `getLanIp()`
- [ ] Configurable mDNS service type (Cast Audio, etc.)
- [ ] Persist last-used device + auto-resume on next play
