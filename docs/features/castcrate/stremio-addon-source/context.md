# stremio-addon-source — Context

**Last updated:** 2026-05-15
**Status:** Phases 1 + 2 + 3 + 4 + 5 + 6 complete; Phases 7–9 pending

## Implementation notes

### Phase 3 decisions
- `startTorrent` extended with optional `opts?: { fileIdx?: number }`. When `fileIdx` is present and in range it picks that file directly. When it is absent or out of range it falls through to `pickVideoFile()`. Out-of-range logs a `console.warn` (not a throw) to keep the torrent boot path resilient.
- The fast-path dedup branch (checking `client.torrents` by infoHash) does not change — it still calls `pickVideoFile()` unconditionally. This is intentional: the fast path is triggered when the same magnet is already downloading, which is not the Stremio scenario (Stremio results each get a fresh `startTorrent` call).

### Phase 4 decisions
- `searchStremioMovie` / `searchStremioEpisode` now return `StremioSearchOutcome { results, errors }`. Breaking change to adapter API — all tests updated accordingly.
- Per-addon errors use an extended error-entry shape `{ source: "stremio", addonId, addonName, code }`. The existing per-source shape `{ source, code }` is a strict subset of this; both shapes coexist in the `errors[]` array via a widened type union. No reshaping of existing TD/Knaben entries was needed.
- `fanOut` was refactored: moved dispatcher construction and cache key computation into `searchStremioMovie`/`searchStremioEpisode` so they can pass these as arguments, keeping the function testable without double-calling `getSettings()`.
- Movie route now accepts optional `?imdbId` query param. Invalid formats (not matching `/^tt\d{5,}$/`) are logged at `warn` level and treated as absent — the request is not rejected.
- Episode route already had `imdbId` as a required param (used by EZTV). Stremio is slotted after EZTV episode results and before the Knaben episode fallback. No changes to the existing EZTV/Knaben/TD wiring.
- `getSettings` imported directly into `routes/torrents.ts` (was not previously imported there) to read `stremioAddons` for the availability check.

### Phase 6 decisions
- `searchStremioMovie` and `searchStremioEpisode` accept an optional `enabledAddonsOverride` parameter (array of addon objects). When provided it bypasses the `getSettings()` read and uses the supplied list directly. The parameter is additive (optional) so existing callers in `routes/torrents.ts` are unchanged.
- `GET /api/stremio/test/:id` passes `[addon]` as the override to target exactly one addon in the Inception canary search.
- `maskStremioUrl(url)` is exported from `routes/stremio.ts` (not from the service layer) because it is a presentation concern. `health.ts` imports and applies it in both `GET /api/settings` and `PATCH /api/settings` responses. Server-internal `getSettings()` continues to return raw URLs.
- `POST /api/stremio/addons` logs the host component of the addon URL only (never the path) to avoid leaking personalised secrets to the log stream.
- `vi.clearAllMocks()` (not `vi.resetAllMocks()`) is used in route tests — `resetAllMocks` would wipe the `normaliseAddonBase` mock implementation, breaking normalisation assertions.
- 24 new tests in `routes/__tests__/stremio.test.ts`. All 214 server tests pass.

### Phase 5 decisions
- **Direct passthrough chosen (Option A).** HTTP streams from debrid CDNs are passed unchanged to the Chromecast/video element. No server-side proxy or transcode. Rationale: avoids doubling LAN bandwidth; debrid CDNs are CORS- and Chromecast-friendly; transcode from a URL input is deferred work.
- `POST /api/torrent/start` returns `{ infoHash: null, streamUrl: <absolute>, videoLength: 0, transcodable: false }` for the stremio+streamUrl branch. `setMeta()` is intentionally omitted — no infoHash to key on.
- `POST /api/cast/play` uses `isAbsolute = /^https?:\/\//i.test(streamPath)` to branch. LAN IP is only resolved when needed (relative path or relative subtitle path). This keeps the 500 guard for local-stream use while being a no-op for external URLs.
- History tracking is skipped for HTTP-stream casts in v1 — `infoHashFromStreamPath` returns null and the existing `if (infoHash)` guard is a natural no-op. TODO comment added.
- `buildMagnetFromStream` now validates tracker schemes: only `udp://`, `http://`, `https://` survive after stripping the `tracker:` prefix. `wss://`, bare hosts, etc. are dropped silently.
- `fanOut` sort is now a two-key comparator: primary is `rankTorrent`, secondary promotes `streamUrl`-having entries over magnet-only within the same rank bucket.
- `validateAddon` return type widens to `{ ok, manifest?, error?, warning? }`. Two advisory checks: missing `"tt"` in `idPrefixes` and `behaviorHints.configurationRequired === true`. Both can fire simultaneously — joined with `" / "`.
- `StremioManifest` interface extended with optional `idPrefixes?: string[]` and `behaviorHints?: { configurationRequired?: boolean; [k: string]: unknown }`.
- `settings.ts` `persist()` now calls `chmod(PATH, 0o600)` after rename. Failure is swallowed silently with a `console.log` warning to handle Windows/non-POSIX filesystems.
- 12 new tests added to `stremio.test.ts` (Phase 5 buckets). All 190 server tests pass.

### Phase 1 decisions
- `sanitise()` in `settings.ts` does whole-array replace for `stremioAddons` — entries with invalid urls or empty ids are filtered out silently, consistent with how other fields are handled.
- `id` validation in the sanitiser accepts whatever non-empty string the client sends, consistent with the spec ("sanitiser accepts whatever's there as long as it's a non-empty string"). Phase 6 endpoints will generate ids server-side on `POST /api/stremio/addons`.
- `proxyEnabled.stremio` partial-merges like other `proxyEnabled` entries — sending `{ proxyEnabled: { stremio: true } }` leaves other flags untouched.

### Phase 2 decisions
- LRU cache TTL set to 10 min (spec said 5-10 min; chose 10 for slightly better debrid URL freshness window without risking staleness).
- `FALLBACK_TRACKERS` constant is defined locally in `stremio.ts` (duplicated from `knaben.ts`) to keep the module self-contained. If it drifts, extract to `lib/quality.ts` in a later pass.
- Cache key is keyed by `addonsHash` of `[id, enabled]` tuples — so toggling an addon or changing the list invalidates the cache without storing raw urls in keys (urls may contain secrets).
- The adapter never logs raw addon URLs — only the manifest `name` from the addon object.

## Problem

cratebuddy's indexer coverage today is four hand-rolled adapters (YTS, EZTV, Knaben, TorrentDay). Each one is a small bet on a single source — when one rotates domains, gets seized, or simply doesn't have a niche release, we have a coverage gap. Each new source means another scraper to write and maintain.

The Stremio ecosystem already solved this. Their addon protocol is a thin HTTP contract that hundreds of community addons implement — torrent aggregators, debrid-enabled streamers, regional libraries, anime indexers. Consuming this protocol gets us instant access to the entire ecosystem without writing N more scrapers.

## Goal

Add a single generic adapter that consumes any Stremio-protocol addon (manifest + stream endpoints). Users paste an addon URL in Settings; cratebuddy treats it as another indexer in the existing fallback chain. Multiple addon URLs supported simultaneously.

## Non-goals

- Implementing the Stremio addon protocol *outbound* (i.e. exposing cratebuddy AS a Stremio addon). Separate feature if we ever go there.
- Supporting Stremio's `catalog` / `meta` / `addon_catalog` resources. Only `stream` is needed for our indexer use case — discovery already runs through OMDb / JustWatch.
- Subtitles via Stremio. Out of scope; we have OpenSubtitles already.
- Hosting / bundling specific addons. Users bring their own URLs.
- Real-Debrid / AllDebrid / Premiumize account management UI. Users configure those *inside the addon* (e.g. via Torrentio's setup flow) and paste the resulting personalised URL.

## Scope

In:
- `services/stremio.ts` adapter — generic Stremio-protocol consumer.
- Runtime setting: `stremioAddons: string[]` — list of manifest URLs.
- Per-addon enable flag (default on when added).
- Validation: ping `/manifest.json` on add to confirm it speaks the protocol.
- Two search shapes: `searchStremioMovie(imdbId)` and `searchStremioEpisode(imdbId, season, episode)`. (Stremio's stream resource is keyed by imdbId, not free-text query — so this slots in *after* OMDb resolves the title to an imdbId, which already happens for everything in cratebuddy.)
- Wire into the fallback chain in `routes/torrents.ts`.
- Settings UI: list of addons with add / remove / enable-toggle / Test button.
- Support both **magnet streams** (`infoHash` + `fileIdx`) and **HTTP streams** (`url`). HTTP streams (Real-Debrid responses) bypass webtorrent entirely — handed straight to the cast / play pipeline.

Out:
- Streaming via webtorrent for HTTP-URL responses — they're already on a CDN, just stream-proxy directly.

## Decisions

- **Position in fallback chain: 2nd, behind YTS only.** Stremio addons aggregate broadly — Torrentio alone covers ~12 trackers, more than our other indexers combined. Putting it ahead of EZTV/Knaben/TorrentDay gives the biggest coverage win for the common case. YTS stays first because for popular movies it's the fastest and most reliable single source.
- **One adapter, many addons.** A user with three addon URLs gets three parallel calls. Concatenate + dedupe (by `infoHash`) the responses before ranking. Failure of one addon doesn't fail the search.
- **imdbId is the join key.** Stremio's stream endpoint is `/stream/movie/<imdbId>.json` and `/stream/series/<imdbId>:<s>:<e>.json`. cratebuddy already has imdbId from OMDb at search time — wire it through the existing search route (it isn't currently passed for movies; minor change).
- **HTTP streams over magnet streams when available.** If a Stremio result has both `url` (debrid-cached HTTP) and `infoHash`, prefer the HTTP one — zero peer wait, instant playback. This requires extending the cast/play pipeline to accept an HTTP stream URL directly, not just magnet/.torrent.
- **No per-addon proxy routing.** Stremio addons are mostly hosted by community members on cloud infrastructure — not geoblocked. If one *is* blocked, user can route via the existing proxy-routing primitive (we'll add a `proxyEnabled.stremio` toggle).
- **`TorrentResult.source = "stremio"`** with optional `addonOrigin?: string` for telemetry / display ("via Torrentio").
- **Cache for 30 min, LRU keyed by imdbId + addonUrl.** Same pattern as other adapters.

## Gotchas

- **Manifest CORS / HTTPS rule.** Stremio's own SDK enforces HTTPS-or-localhost on the *client* side; our server-side call doesn't care. Skip CORS — we're not running in a browser context.
- **Addon URL shapes vary.** Some addons embed user-config in the URL path: `https://torrentio.strem.fun/<base64-config>/manifest.json`. Manifest URL might be `…/manifest.json` or `…/`. Normalise: strip trailing `/manifest.json` → use that as the base, append `/manifest.json` or `/stream/...` as needed.
- **Quality parsing.** Stremio results return `title` (release name) and `name` (addon label, e.g. "Torrentio 1080p"). Parse `parseQuality(title)` from `lib/quality.ts` for resolution / codec — already battle-tested.
- **Real-Debrid responses have time-limited URLs.** A user pulls a Torrentio result, sees `url: https://real-debrid.com/d/abc...`, picks it 10 minutes later → URL has expired. Mitigate: don't cache the `url` field; cache only the per-imdbId result list with a short TTL (5-10 min) and re-query on stale.
- **Some addons rate-limit aggressively.** Torrentio specifically has had public-instance rate limits. Encourage users to self-host or use the configured personalised URL. Document this.
- **Magnet field shape.** Stremio returns `infoHash` separately from a trackers list (`announce: string[]`). Reconstruct a magnet URI client-side: `magnet:?xt=urn:btih:<infoHash>&dn=<title>&tr=<announce1>&tr=<announce2>…`. Reuse the existing `buildMagnet()` helper from `knaben.ts` (or extract to `lib/quality.ts`).
- **`fileIdx` in Stremio results.** Some addons return a multi-file torrent + an index pointing to the specific episode file. We currently auto-pick the largest video file in `services/torrent.ts`; need to honour `fileIdx` when present so the right episode plays.
- **Tracker risk.** Stremio addons can be hostile (malicious URLs, tracking pixels). Add a Settings warning that addon URLs are *bearer URLs* — they can contain user-config secrets (Real-Debrid API keys) — and to treat them like passwords.

## Epic Review Findings (2026-08-09)

- 🔗 **Fallback wiring duplication** — spans yts ↔ knaben ↔ torrentday ↔ stremio — extract `FallbackChain`. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Stremio HTTP-stream sessions bypass history** — spans stremio ↔ library-settings ↔ transcoding — TODO in `cast.ts` is load-bearing; decide synthetic-id or explicit UI surfacing. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Stream URL absolute-vs-relative implicit** — spans yts ↔ chromecast ↔ stremio ↔ transcoding — add `streamUrlType?` discriminator. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Proxy cache suffix by convention** — spans proxy ↔ yts ↔ knaben ↔ torrentday ↔ stremio. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Adapter error boundary asymmetric** — spans yts ↔ knaben ↔ torrentday ↔ stremio ↔ proxy. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Sensitive settings write with default umask before `6e4f73e`** — spans proxy ↔ stremio ↔ torrentday — Real-Debrid keys stored plaintext; audit existing 0o644. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Addon URL normalization is heuristic** — spans stremio ↔ discovery ↔ proxy — brittle strip-and-rebuild; reject unrecognized shapes at `validateAddon`. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 💳 **Addon URLs are bearer tokens plaintext (0o600 only); manifest validation loose** — validation checks `manifest.name` but not `resources: ["stream"]`. Tighten validation; document trust model; per-addon privacy warning. (See epic-overview.md → Tech Debt / Findings.)

_Recorded by /review-epic castcrate on 2026-08-09._
