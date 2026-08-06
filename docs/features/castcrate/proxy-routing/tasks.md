# proxy-routing — Tasks

**Last updated:** 2026-05-15
**Progress:** Phases 1-3 + Phase 5 + Phase 6 (.env.example) complete (server-side done)

## Phase 1 — Settings + lib (server)

- [x] Extend `RuntimeSettings` in `apps/server/src/services/settings.ts` with `proxyUrl: string \| null` and `proxyEnabled: { yts, eztv, knaben, torrentday }`.
- [x] Update `ALLOWED_KEYS` and `sanitise()` to validate proxy URL scheme + boolean coercion for the toggle map.
- [x] Add `PROXY_URL` to `lib/config.ts` env defaults; layer into `getSettings()`.
- [x] Add `lib/proxy.ts` exporting `getDispatcher(provider)` + `redactProxyUrl(url)`.
- [x] Decide SOCKS approach (custom undici connector vs scoped `node-fetch`). **Chose undici Agent({ connect }) with socks-proxy-agent.connect() async adapter.** Documented inline.
- [x] Add `socks-proxy-agent` to `apps/server/package.json`.

## Phase 2 — Provider wiring

- [x] `services/yts.ts` — pass dispatcher; cache key suffix `::proxy:on|off`.
- [x] `services/eztv.ts` — same.
- [x] `services/knaben.ts` — same.

## Phase 3 — Test endpoint

- [x] `routes/proxy.ts` — `GET /api/proxy/test?provider=…`. Register in `index.ts`.
- [x] Returns `{ ok, egressIp?, error?, elapsedMs }`. 5s abort timeout.

## Phase 4 — UI

- [x] Locate the existing settings dialog component and add a "Network" section.
- [x] Proxy URL input (masked on render once saved).
- [x] 4 provider checkboxes.
- [x] "Test" button per provider — hits `/api/proxy/test`, renders egress IP or error inline.
- [x] Help copy: "indexer searches only — peer traffic is not proxied".

## Phase 5 — Tests

- [x] `lib/__tests__/proxy.test.ts` — `redactProxyUrl()` masking, URL validation, `getDispatcher()` selection matrix.
- [x] Extend settings tests for proxy fields round-trip + partial-merge of `proxyEnabled`.
- [ ] Manual smoke: configure Mullvad SOCKS5, hit `/api/proxy/test?provider=eztv`, verify egress IP differs from direct.

## Phase 6 — Docs

- [x] `.env.example` — `PROXY_URL=` with comment.
- [x] README — short "Geo-blocked indexers" section explaining the proxy is for HTTP only, recommending Mullvad / ProtonVPN / AirVPN as SOCKS5-capable providers.
- [x] Note in README that ratio/anonymity for peer connections is **not** provided by this feature.

## Future enhancements

### Medium
- [ ] Per-provider proxy URLs.
- [ ] Health-check cron that flags proxy outage in UI.
- [ ] Encrypt `proxyUrl` at rest (OS keychain).

### Low
- [ ] Auto-failover between multiple proxies.
- [ ] Route WebTorrent peer connections via SOCKS5 (significant work — needs custom `bittorrent-protocol` socket factory).
- [ ] Per-provider egress-IP display in main UI footer (debug aid).
