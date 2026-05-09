# chromecast — Tasks

**Last updated:** 2026-05-09
**Progress:** Implemented (retrospective)

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
- [ ] Session heartbeat — drop stale sessions after N seconds of no status tick
- [ ] WebSocket push for cast state (replace 1s poll); plugin already registered

### Medium priority
- [ ] Multi-session support (e.g. concurrent Chromecasts in different rooms)
- [ ] Runtime subtitle track switching via `Media.editTracksInfo`
- [ ] Friendly error UI when the receiver rejects load (codec mismatch)

### Low priority
- [ ] IPv6 support in `getLanIp()`
- [ ] Configurable mDNS service type (Cast Audio, etc.)
- [ ] Persist last-used device + auto-resume on next play
