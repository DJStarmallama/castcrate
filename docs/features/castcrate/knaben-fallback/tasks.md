# knaben-fallback — Tasks

**Last updated:** 2026-05-09
**Progress:** Implemented (retrospective)

## Original implementation (completed)

- [x] `services/knaben.ts` — adapter, LRU(200, 1h)
- [x] `searchKnabenMovie()`, `searchKnabenEpisode()`
- [x] `episodeMatchesTitle()` — S01E05, s01e05, 1x05, 1x5, S1E5, "Season 1 Episode 5"
- [x] `magnetFor()` — prefer `magnetUrl` → `magnet` → `buildMagnet(hash)` with 6 trackers
- [x] Movie fallback wiring (YTS empty → Knaben)
- [x] Episode fallback wiring (EZTV empty + title → Knaben)
- [x] `tried` array surfaced in response
- [x] EpisodePicker `EmptyResults` consumes `tried`; `extractTried()` parses error msg
- [x] Web client passes optional `&title=` for episode search
- [x] `lib/dns.ts` — `setupDnsBypass()` monkey-patches `dns.lookup`
- [x] Cloudflare 1.1.1.1/1.0.0.1 defaults; `DNS_UPSTREAMS` env override; `DNS_BYPASS=false` to disable
- [x] `index.ts` calls `setupDnsBypass()` at boot
- [x] Vitest for `episodeMatchesTitle()` (7 cases)
- [x] Migration to `api.knaben.org` (commit 1d279aa)

## Future enhancements

### High priority
- [ ] Document `KNABEN_BASE_URL`, `DNS_BYPASS`, `DNS_UPSTREAMS` in `.env.example`
- [ ] 429 + backoff handling for Knaben
- [ ] Vitest fixtures for Knaben API (success, empty, error)

### Medium priority
- [ ] Knaben season-pack search path
- [ ] Per-indexer DNS-bypass scoping
- [ ] Fuzzy title match fallback when episode tag + regex both fail
- [ ] UI hint when a fallback was used (turn `tried` into a visible badge)

### Low priority
- [ ] Configurable tracker list for `buildMagnet` reconstruction
- [ ] Parallel prefetch (Knaben in flight while YTS/EZTV resolves) for faster fallback
- [ ] Telemetry on which indexer served each magnet
- [ ] Vitest for DNS bypass behaviour
