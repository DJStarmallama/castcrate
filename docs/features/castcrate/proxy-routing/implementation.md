# Feature: proxy-routing

**Status:** Spec
**Authored:** 2026-05-15

## Executive summary

Add per-provider outbound proxy routing so geo-blocked indexers (EZTV, Knaben, future TorrentDay) can be reached via a user-supplied SOCKS5 / HTTP proxy. Routing is opt-in per provider; default off. WebTorrent peer traffic is out of scope — only indexer search + `.torrent` blob fetches go through the proxy.

---

## Architecture

```
RuntimeSettings
  ├── proxyUrl: string | null            ── e.g. "socks5h://user:pw@proxy.mullvad.net:1080"
  └── proxyEnabled: { eztv, knaben, torrentday, yts }   ── per-provider booleans

services/eztv.ts ─┐
services/knaben.ts ─┼─▶  lib/proxy.ts → getDispatcher("eztv" | "knaben" | …)
services/yts.ts  ─┤        │
services/torrentday.ts ─┘  ├─ enabled & url present → wrap proxy
                           └─ else                  → undici default

routes/proxy.ts → GET /api/proxy/test  (verify reachability + show egress IP)

routes/settings.ts → PATCH adds proxyUrl + proxyEnabled
```

## Key files (planned)

| Path | Role |
|---|---|
| `apps/server/src/lib/proxy.ts` | `getDispatcher(provider)` — returns `undici.Dispatcher` or `undefined`; redacts URL for logs |
| `apps/server/src/services/settings.ts` | extend `RuntimeSettings` + `sanitise()` for `proxyUrl`, `proxyEnabled` |
| `apps/server/src/services/eztv.ts` | thread `dispatcher` into `fetch(url, { dispatcher })` |
| `apps/server/src/services/knaben.ts` | same |
| `apps/server/src/services/yts.ts` | same (toggle off by default) |
| `apps/server/src/routes/proxy.ts` | new — `GET /api/proxy/test` |
| `apps/web/src/components/SettingsDialog.tsx` (or equivalent) | input for URL + 4 checkboxes + "Test proxy" button |
| `apps/server/src/lib/__tests__/proxy.test.ts` | URL parsing, redaction, dispatcher selection |
| `.env.example` | document optional `PROXY_URL` env default |

## Settings shape

Extend `RuntimeSettings` in `services/settings.ts`:

```ts
export interface RuntimeSettings {
  bufferPercent: number;
  transcodeBufferPercent: number;
  transcodeBitrate: string;
  proxyUrl: string | null;
  proxyEnabled: {
    yts: boolean;
    eztv: boolean;
    knaben: boolean;
    torrentday: boolean;
  };
}
```

Defaults: `proxyUrl: null`, all `proxyEnabled.*: false`.

`sanitise()` validation:
- `proxyUrl`: `null` or matches `/^(socks5h?|http|https):\/\/.+/`. Reject anything else (including bare hosts).
- `proxyEnabled.*`: cast to boolean.

`updateSettings()` semantics: passing `proxyUrl: null` clears, `proxyEnabled: {}` is a partial merge (per-key).

## `lib/proxy.ts` surface

```ts
export type ProxyProvider = "yts" | "eztv" | "knaben" | "torrentday";

/** Returns a Dispatcher when the provider should be proxied; undefined otherwise. */
export function getDispatcher(provider: ProxyProvider): Dispatcher | undefined;

/** "socks5h://USER:****@host:1080" — safe to log. */
export function redactProxyUrl(url: string): string;
```

Implementation notes:
- For `http://` / `https://` proxy URLs → `new ProxyAgent(url)` from `undici`.
- For `socks5://` / `socks5h://` → use `socks-proxy-agent` to build an HTTP agent, then wrap it inside an `undici.Agent({ connect })` with a custom connector that opens a socket via the SOCKS agent. (Alternative: keep a `node-fetch` import scoped to SOCKS-routed providers — simpler but adds a dep.)
- Pick one approach during implementation; don't ship both.
- Cache dispatchers keyed by `${url}::${provider}` for the lifetime of the settings value. Invalidate on `updateSettings`.

## Provider wiring

Each provider's existing `fetch(url, opts)` call becomes:

```ts
import { getDispatcher } from "../lib/proxy.js";
const dispatcher = getDispatcher("eztv");
res = await fetch(url, { headers, dispatcher });
```

No other changes to ranking, filtering, caching except:

- Cache key gets `::proxy:${dispatcher ? "on" : "off"}` suffix to prevent cross-mode pollution.

## `GET /api/proxy/test`

```
GET /api/proxy/test?provider=eztv
→ 200 { ok: true,  egressIp: "185.213.155.169", elapsedMs: 412 }
→ 200 { ok: false, error: "ECONNREFUSED",        elapsedMs: 5021 }
```

Implementation:
1. `getDispatcher(provider)` — if `undefined`, return `{ ok: false, error: "proxy disabled for provider" }`.
2. `fetch("https://api.ipify.org?format=json", { dispatcher, signal: AbortSignal.timeout(5000) })`.
3. Return egress IP + elapsed ms. Never return the proxy URL itself.

## UI changes (Settings dialog)

- Section: **"Network → Proxy (optional)"**
  - Text input: Proxy URL (placeholder: `socks5h://user:pass@host:1080`)
  - Help text: "Routes indexer searches only. Peer traffic is not proxied."
  - 4 checkboxes — Enable for: YTS · EZTV · Knaben · TorrentDay
  - **Test proxy** button per provider — calls `/api/proxy/test?provider=…`, shows egress IP / error inline.
- Stored value masked on display (`socks5h://****@host:1080`) — re-typed to change.

## Logging

- On startup, log `proxy: enabled for [eztv, knaben]` (no URL).
- On dispatcher creation, log `proxy: dispatcher created for eztv (socks5h://****@proxy.example:1080)`.
- On fetch error through proxy, include `via=proxy` in the existing error log; include `redactProxyUrl()` output, never raw.

## Failure modes

| Scenario | Behaviour |
|---|---|
| `proxyUrl` invalid | `updateSettings` rejects with 400 |
| Proxy unreachable | Provider fetch errors → propagates to existing 502 / fallback logic |
| Proxy slow (>10s) | `AbortSignal.timeout(10000)` on each fetch → treated as empty; Knaben fallback kicks in for EZTV |
| User toggles off mid-session | Next request uses direct route; cached entries from proxy mode aren't reused (cache key differs) |
| Proxy returns 407 (auth required) | Bubbled as fetch error; surfaced in `/api/proxy/test` response |

## Tests

- `proxy.test.ts`
  - `redactProxyUrl()` masks userinfo, leaves host:port intact.
  - `getDispatcher()` returns `undefined` when disabled, dispatcher when enabled+url, `undefined` when enabled+no url.
  - URL validation rejects bare hosts, accepts all 4 schemes.
- Settings tests: `proxyUrl` round-trips through `updateSettings`; `proxyEnabled` partial merge.
- No live network test in CI for the proxy itself (would require a fixture proxy). Document manual `/api/proxy/test` smoke check in tasks.

## Dependencies to add

- `socks-proxy-agent` (~5KB, mature). `undici` is already transitively present via Node 20 built-ins.
- No new dep if we go pure-`undici` route (currently `ProxyAgent` only supports HTTP). SOCKS support is the deciding factor.

## Migration

- Settings file (`~/.castcrate/settings.json`) gains two new keys; absence treated as defaults. No migration needed.
- `.env.example` adds optional `PROXY_URL` for users who prefer env over UI (read at boot, used as default for `overrides.proxyUrl` if unset).

## Out of scope (future)

- Per-provider proxy URLs.
- Routing WebTorrent peer connections via SOCKS5 (`webtorrent` doesn't natively support; would need `bittorrent-protocol` + `socks` plumbing).
- Proxy URL encryption at rest.
- Auto-rotating proxy lists.
- Health-check cron that warns when the proxy goes down.
