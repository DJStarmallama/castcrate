# stremio-addon-source — Tasks

**Last updated:** 2026-05-15
**Progress:** Phases 1 + 2 + relevant Phase 8 tests complete

## Phase 1 — Settings + types

- [x] Extend `RuntimeSettings` in `services/settings.ts` with `stremioAddons: StremioAddon[]` (default `[]`) and `proxyEnabled.stremio: boolean` (default false).
- [x] `sanitise()` validates each addon entry: `url` matches `/^https?:\/\/.+/`; `id` server-generated only; `name` truncated to 60 chars; `enabled` boolean.
- [x] Extend `lib/proxy.ts` `ProxyProvider` union with `"stremio"`.
- [x] `packages/shared/src/index.ts`:
  - `TorrentResult.source` adds `"stremio"`.
  - Add optional `streamUrl?: string` (HTTP stream URL — bypass webtorrent).
  - Add optional `fileIdx?: number` (multi-file torrent picker).
  - Add optional `addonOrigin?: string` (e.g. "Torrentio").

## Phase 2 — Adapter (`services/stremio.ts`)

- [x] `validateAddon(url)` — probe `/manifest.json`, confirm `resources` includes `"stream"`. URL normalisation: strip trailing `/manifest.json` and trailing slash.
- [x] `searchStremioMovie(imdbId)` — `Promise.allSettled` fan-out across enabled addons; 8s per-addon timeout.
- [x] `searchStremioEpisode(imdbId, s, e)` — same fan-out, episode URL shape `/stream/series/<id>:<s>:<e>.json`.
- [x] Parser handles both `infoHash` + `url` stream shapes.
- [x] Magnet reconstruction from `infoHash` + `sources[]` tracker list; fall back to hardcoded tracker list when `sources[]` absent.
- [x] Dedupe results by `infoHash` (when set) or `streamUrl` (when set), first-wins.
- [x] LRU cache, 10 min TTL (short — Real-Debrid URLs are time-limited). Key includes proxy on/off suffix.
- [x] Reuse `getDispatcher("stremio")` from `lib/proxy.ts`.
- [x] Reuse `parseQuality()` from `lib/quality.ts`.
- [x] **Don't** drop on `seeds === 0` for Stremio source (Stremio doesn't expose seed counts).

## Phase 3 — Torrent client integration (`services/torrent.ts`)

- [x] `startTorrent(input, opts?: { fileIdx?: number })` — honour `fileIdx` when provided; fall back to `pickVideoFile()` when absent.

## Phase 4 — Fallback wiring (`routes/torrents.ts`)

- [x] Movie search route accepts new optional `imdbId` query param. Web client already has imdbId; thread it through.
- [x] Movie route fallback chain: YTS → Stremio (if imdbId + enabled addons) → Knaben → TD.
- [x] Episode route fallback chain: EZTV → Stremio (if imdbId) → Knaben → TD.
- [x] `tried` array gets `"stremio"` when invoked.
- [x] Per-addon errors captured in errors array without failing the chain.

## Phase 5 — Stream pipeline (audit-revised scope)

Design decision: **direct passthrough** (Option A from implementation.md). External URL → Chromecast / `<video>` directly. No server-side proxy or transcode for HTTP streams in this phase.

### Pipeline plumbing

- [x] `POST /api/torrent/start` — new `streamUrl` body branch: validates `http(s)://` scheme, returns synthetic session `{ infoHash: null, streamUrl: <absolute URL>, videoName, videoLength: 0, videoCodec, transcodable: false }`. No `setMeta()`.
- [x] `POST /api/cast/play` — detect absolute URL in `streamPath` and pass through unchanged (skip the `http://${ip}:${config.port}` prefix). Magnet/torrent path unchanged.
- [x] Confirm `infoHashFromStreamPath` returns null for absolute URLs and the history block is a no-op (existing null-guard handles it). Add a TODO comment that HTTP-stream history is intentionally skipped in v1.

### Adapter fixes (audit-derived)

- [x] `buildMagnetFromStream` — filter `sources[]` tracker URLs to only `udp://`, `http://`, `https://` schemes after stripping `tracker:` prefix. Drop malformed entries silently.
- [x] `fanOut` — stable secondary sort after `rankTorrent`: HTTP-shape (streamUrl set) results boost above magnet-shape within the same rank bucket.
- [x] `validateAddon` — check `manifest.idPrefixes`. If present and doesn't include `"tt"`, return `{ ok: true, manifest, warning: "..." }`.
- [x] `validateAddon` — check `manifest.behaviorHints.configurationRequired`. If true, return `{ ok: true, manifest, warning: "..." }`. Return type widens to include `warning?: string`.

### Settings file hardening

- [x] `services/settings.ts` — after every `writeFile` / `rename` in `persist()`, `fs.chmod(PATH, 0o600)` so credentials in the JSON (TD cookies, proxy URL, Stremio personalised URLs) aren't world-readable on shared-user systems. One-liner with a comment.

### Tests

- [x] `stremio.test.ts` — `buildMagnetFromStream` skips malformed tracker entries.
- [x] `stremio.test.ts` — HTTP-shape results sort above magnet-shape within the same quality bucket.
- [x] `stremio.test.ts` — `validateAddon` returns `warning` when manifest has `idPrefixes` lacking `"tt"`.
- [x] `stremio.test.ts` — `validateAddon` returns `warning` when manifest has `behaviorHints.configurationRequired = true`.
- [ ] Manual smoke: route a `streamUrl` payload through `/api/torrent/start` and `/api/cast/play` against a non-debrid HTTP URL (e.g. Big Buck Bunny mp4 on a public CDN). Confirm Chromecast plays without webtorrent involvement.

### Phase 7 follow-ups (not in this phase — tracked here for visibility)

- HEVC + Chromecast confirm dialog when user picks a non-castFriendly Stremio HTTP result.
- URL-expiry error toast in the cast pipeline when an external stream returns 4xx mid-play.

## Phase 6 — API endpoints (`routes/stremio.ts`)

- [ ] `POST /api/stremio/addons` body `{ url }` → validates manifest, generates id, appends, returns the new entry.
- [ ] `DELETE /api/stremio/addons/:id` → removes from settings list.
- [ ] `GET /api/stremio/test/:id` → runs `searchStremioMovie("tt1375666")` (Inception) → returns `{ ok, sampleCount, firstTitle?, error? }`.
- [ ] Register routes in `index.ts`.

## Phase 7 — UI

- [ ] Find Indexers section in `Settings.tsx` and add "Stremio Addons" subsection below TorrentDay.
- [ ] Help copy mentions Torrentio + Real-Debrid as the popular combo.
- [ ] Add input + Add button (POST to `/api/stremio/addons`); inline validation result.
- [ ] List of installed addons with name, truncated URL, Enable toggle, Test button, Remove button.
- [ ] Warning copy: addon URLs may contain personalised secrets — treat like passwords.
- [ ] Web client `TorrentResult` type extension; cast/play call sends `streamUrl` for stremio HTTP-shape results.

## Phase 8 — Tests

- [x] `stremio.test.ts` — manifest probe (valid + invalid).
- [x] `stremio.test.ts` — stream parse with mixed shapes (infoHash + url).
- [x] `stremio.test.ts` — dedupe by infoHash across two fake addons.
- [x] `stremio.test.ts` — `Promise.allSettled` semantics (one fails, others succeed).
- [x] `stremio.test.ts` — URL normalisation (trailing slash, trailing /manifest.json).
- [x] `settings.test.ts` — stremioAddons round-trip; URL validation; immutable id.
- [ ] Manual smoke:
  - [ ] Add Torrentio non-RD URL → search popular movie → Stremio results present.
  - [ ] Add Torrentio-RD personalised URL → search → `streamUrl` results visible → casting plays without webtorrent.
  - [ ] Toggle off → no Stremio results in next search.
  - [ ] Remove addon → list updates.

## Phase 9 — Docs

- [ ] README section under Networking: "Stremio addons" — explain what they are, recommend Torrentio + Real-Debrid combo, link to Stremio addon catalog.
- [ ] Note the bearer-URL warning prominently.
- [ ] Note that `seeds` and `peers` aren't reported by Stremio — results may appear with seeds=0 but still play.

## Future enhancements

### Medium
- [ ] Per-addon proxy routing (currently single `proxyEnabled.stremio` flag).
- [ ] Surface "via &lt;addon name&gt;" badge on Stremio-sourced results in the UI.
- [ ] Auto-detect debrid URL expiry; re-query the addon when expired.
- [ ] Consume Stremio `meta` resource for richer metadata (alternative to OMDb).

### Low
- [ ] Stremio `catalog` resource (catalog browsing — would compete with our discover tab).
- [ ] Expose cratebuddy AS a Stremio addon (separate identity decision).
- [ ] Auto-discover community addon lists.
- [ ] Subtitle resource consumption (OpenSubtitles already integrated).
