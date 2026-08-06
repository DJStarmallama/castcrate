# proxy-routing — Context

**Last updated:** 2026-05-15
**Status:** Server-side complete; UI (Phase 4) complete; README docs pending

## Phase 4 UI decisions

- `redactProxyUrl` placed in `apps/web/src/lib/format.ts` (alongside existing format helpers) — uses `new URL()` with a `catch` fallback to "•••".
- `ProxyEnabled`, `ProxyTestResult`, `ProxyProvider` types added to `apps/web/src/lib/api.ts` alongside the existing `RuntimeSettings` interface; `testProxy(provider)` added to `api` object.
- Proxy URL display uses a two-state pattern: stored URL shows masked + Edit/Clear buttons; no-URL or editing state shows the text input + Save/Cancel. Avoids ever rendering the raw stored URL in the DOM.
- Checkboxes call `save.mutate` immediately (save-on-change), consistent with how the smooth-playback toggle works.
- Test results reset on settings change (URL save, toggle change, or fresh data from server) to avoid stale egress IPs misleading the user.
- The "Network — Proxy" section is rendered outside the `{sys.data && ...}` guard so it's always visible (proxy config doesn't depend on system check data).

## Problem

Several torrent indexers cratebuddy already integrates with (EZTV, Knaben) and any future ones (TorrentDay) are DNS- or IP-blocked by AUS ISPs. The existing `lib/dns.ts` Cloudflare bypass handles DNS-level NXDOMAIN blocks but not IP-layer blocks or Cloudflare-fronted geofencing. Users today have to run a system-wide VPN, which disrupts unrelated traffic (LAN Cast discovery, OMDb, JustWatch).

## Goal

Allow individual outbound HTTP requests in the server to be routed through a user-supplied SOCKS5 / HTTP proxy, gated per-provider via runtime settings. No system VPN, no kernel-level changes, no elevated permissions.

## Non-goals

- Bundling or operating a VPN service ourselves.
- Routing WebTorrent peer (BitTorrent swarm) traffic through the proxy. Only the indexer search + `.torrent` blob fetch goes through the proxy. Peer connections stay direct. (AUS blocks are at HTTP/DNS layer, not BitTorrent peers.)
- Per-request rotation across multiple proxies.
- Encrypting credentials at rest beyond what `~/.castcrate/settings.json` already provides (file-mode 600 is acceptable v1; flag for future hardening).

## Scope

In:
- New runtime settings: `proxyUrl`, `proxyEnabled: { eztv, knaben, torrentday, yts }`.
- HTTP layer helper that returns an `undici` `Dispatcher` (proxy or direct) per-request.
- Wire helper into `services/eztv.ts`, `services/knaben.ts`, `services/yts.ts` (yts off by default — public, doesn't need it).
- Settings UI control to set proxy URL + per-provider toggles.
- Health-check endpoint — `GET /api/proxy/test` — verifies the proxy resolves an external IP.

Out:
- TorrentDay adapter itself (separate feature `torrentday-indexer/`). This feature only ships the routing primitive; the TorrentDay flag is reserved.
- WebTorrent peer routing.

## Decisions

- **SOCKS5 + HTTP proxy via `undici` dispatchers, not a global agent.** Per-request opt-in keeps unrelated traffic (OMDb, JustWatch, Cast) on the direct route. `undici.ProxyAgent` for HTTP/HTTPS proxies; `socks-proxy-agent` for SOCKS5 (wraps to a dispatcher).
- **User brings their own proxy.** Mullvad / ProtonVPN / AirVPN all expose SOCKS5 endpoints. We don't ship credentials, recommendations live in README only.
- **Per-provider toggle, default off.** Users not in blocked regions pay zero overhead.
- **Single proxy URL, not per-provider.** Avoids credential sprawl. If someone wants per-provider proxies later, extend the schema then.
- **Proxy applies to indexer HTTP only, not peer traffic.** Documented loudly. Avoids the trap of users assuming ratio/anonymity protection that isn't there.
- **Failure surfaces as a normal indexer error.** If the proxy is down, the affected provider returns empty / 502; existing fallback logic (Knaben after EZTV) kicks in. No silent direct-fallback — that would defeat the geoblock workaround.

## Implementation decisions made

- **SOCKS connector approach**: Chose `undici.Agent({ connect })` with a custom async adapter that calls `SocksProxyAgent.connect()` and bridges the result to undici's `buildConnector.Callback`. Avoids adding `node-fetch` as a dependency.
- **`fetch()` type cast**: Node's global `fetch` `RequestInit` doesn't include `dispatcher`. All provider calls cast via `as UndiciRequestInit as unknown as RequestInit` at the call site. This is a known TypeScript limitation when mixing Node globals with undici-specific options.
- **`onSettingsUpdate` hook**: Added a lightweight callback registry to `settings.ts` (`onSettingsUpdate(cb)`) so `proxy.ts` can self-register for cache invalidation without `settings.ts` having to import `proxy.ts` (which would create a circular dep).
- **Cache key for providers**: `"${proxyUrl}::${provider}"` — one dispatcher per URL+provider pair, cleared on settings change.
- **`PROXY_URL_RE` exported from settings.ts**: Exported for transparency; tests mirror the regex inline to avoid depending on the mock.

## Gotchas to design around

- **Credential leak in logs.** Never log the full `proxyUrl` — redact userinfo before any log line.
- **DNS via proxy vs local.** SOCKS5 supports remote DNS (`socks5h://`). Default to remote DNS so the user's ISP DNS isn't queried for the blocked host. Document the `socks5h://` vs `socks5://` distinction.
- **Settings hot-reload.** `getSettings()` is sync. Building a fresh dispatcher per request is fine (cheap); cache one keyed by URL+enabled-flag if profiling shows otherwise.
- **`socks-proxy-agent` is not a `Dispatcher`.** It's a Node `http.Agent`. To pipe through `fetch` (undici) we need either `undici.Agent({ connect })` with a custom connector, or fall back to `node-fetch` for SOCKS-routed providers. Pick one approach in implementation; don't mix. → **Chose undici connector approach.**
- **Cache poisoning.** Existing LRU caches in providers key on query only. If user toggles proxy on/off, cached results from the wrong route may persist. Bump cache key with a `proxy:on|off` segment, or flush on settings change. → **Implemented `::proxy:on|off` suffix in all three providers.**
