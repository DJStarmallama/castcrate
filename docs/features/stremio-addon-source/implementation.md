# Feature: stremio-addon-source

**Status:** Spec
**Authored:** 2026-05-15
**Depends on:** `proxy-routing` (for the dispatcher infrastructure — addons rarely need proxying but the toggle should exist)

## Executive summary

Generic adapter that consumes any Stremio-protocol addon, slotted second in the indexer fallback chain (after YTS). One adapter, many addons. Adds support for HTTP streams (Real-Debrid responses) bypassing webtorrent for instant playback. Adds `fileIdx` honouring for multi-file torrents.

---

## The Stremio stream protocol (subset we use)

**Manifest probe** (called once at add time to validate):
```
GET <baseUrl>/manifest.json
→ {
    id: "org.example.torrentio",
    version: "1.2.3",
    name: "Torrentio",
    resources: ["stream"],   // must include "stream"
    types: ["movie", "series"]
  }
```

**Stream lookup**:
```
GET <baseUrl>/stream/movie/<imdbId>.json
GET <baseUrl>/stream/series/<imdbId>:<season>:<episode>.json
→ {
    streams: [
      {
        name: "Torrentio 1080p",
        title: "Inception.2010.1080p.BluRay.x264-...",
        infoHash: "abcdef...",
        fileIdx: 0,
        sources: ["tracker:udp://...", "dht:..."]   // tracker URLs
      },
      {
        name: "Torrentio RD",
        title: "Inception 4K HDR",
        url: "https://download.real-debrid.com/d/abc.../movie.mkv",
        behaviorHints: { videoSize: 12345678901 }
      }
    ]
  }
```

Two stream shapes:
- **Magnet shape** — `infoHash` + `fileIdx` + `sources[]` (we build a magnet from these).
- **HTTP shape** — `url` (direct download URL, usually debrid-cached).

## Architecture

```
RuntimeSettings
  ├── stremioAddons: Array<{ url, name, enabled }>
  └── proxyEnabled.stremio: boolean    (added to the proxy-routing toggle map)

services/stremio.ts
  ├── validateAddon(url) → { ok, manifest? }            // probe /manifest.json at add time
  ├── searchStremioMovie(imdbId)
  ├── searchStremioEpisode(imdbId, s, e)
  └── internal: callOneAddon(addon, path), parseStream(), buildMagnetFromStream()

packages/shared/src/index.ts
  TorrentResult.source += "stremio"
  TorrentResult.streamUrl?: string                       // when set, bypass webtorrent
  TorrentResult.fileIdx?: number                         // multi-file torrent picker
  TorrentResult.addonOrigin?: string                     // "Torrentio" etc.

routes/torrents.ts (fallback chain)
  movie:    YTS → Stremio → Knaben → EZTV-impossible → TD
  episode:  YTS-impossible → Stremio → EZTV → Knaben → TD

services/torrent.ts
  startTorrent(input, opts?) where opts.fileIdx selects a specific file

routes/torrents.ts (stream pipeline)
  POST /api/torrent/start  when result.streamUrl set:
    → no webtorrent — return { streamUrl: result.streamUrl } directly
    → cast/play pipeline already accepts streamUrl
```

## Key files (planned)

| Path | Role |
|---|---|
| `apps/server/src/services/stremio.ts` | adapter — validate, search, parse |
| `apps/server/src/services/settings.ts` | extend `RuntimeSettings.stremioAddons` + `proxyEnabled.stremio` |
| `apps/server/src/lib/proxy.ts` | `ProxyProvider` adds `"stremio"` |
| `apps/server/src/services/torrent.ts` | `fileIdx` support in `startTorrent` |
| `apps/server/src/routes/torrents.ts` | wire into fallback chain; HTTP-stream branch in `/api/torrent/start` |
| `apps/server/src/routes/stremio.ts` | `POST /api/stremio/addons` (validate + add), `DELETE /api/stremio/addons/:id`, `GET /api/stremio/test/:id` |
| `apps/web/src/components/Settings.tsx` | "Stremio Addons" subsection inside Indexers |
| `packages/shared/src/index.ts` | `TorrentResult` extensions |
| `apps/server/src/services/__tests__/stremio.test.ts` | fixture-driven parser tests |

## Settings shape

Extend `RuntimeSettings`:

```ts
interface StremioAddon {
  id: string;          // generated; uuid or sha1(url).slice(0,8)
  url: string;         // base URL (no trailing /manifest.json)
  name: string;        // pulled from manifest at add time
  enabled: boolean;
}

interface RuntimeSettings {
  // … existing
  stremioAddons: StremioAddon[];
  proxyEnabled: {
    yts: boolean; eztv: boolean; knaben: boolean;
    torrentday: boolean;
    stremio: boolean;   // new
  };
}
```

Default: `stremioAddons: []`, `proxyEnabled.stremio: false`.

`sanitise()`:
- Each addon URL must match `/^https?:\/\/.+/`.
- `id` server-generated; client cannot set.
- `name` truncated to 60 chars.

PATCH semantics:
- Sending whole `stremioAddons` array replaces.
- Add via `POST /api/stremio/addons` (single addon) — server probes manifest, generates id, appends.
- Remove via `DELETE /api/stremio/addons/:id`.

## `services/stremio.ts` surface

```ts
export interface StremioStreamResult extends TorrentResult {
  source: "stremio";
  addonOrigin: string;        // addon's manifest.name
  // Either:
  streamUrl?: string;         // direct HTTP stream (debrid)
  // …or:
  magnet?: string;            // reconstructed magnet
  fileIdx?: number;
}

export async function validateAddon(url: string): Promise<{
  ok: boolean;
  manifest?: { id: string; name: string; version: string; resources: string[]; types: string[] };
  error?: string;
}>;

export async function searchStremioMovie(imdbId: string): Promise<StremioStreamResult[]>;

export async function searchStremioEpisode(
  imdbId: string, season: number, episode: number,
): Promise<StremioStreamResult[]>;
```

Internals:
- **URL normalisation:** if user pastes `…/manifest.json`, strip it. If trailing slash, strip. Store base URL only.
- **Parallel fan-out:** for N enabled addons, fire all N stream requests concurrently with `Promise.allSettled`. 8s timeout each.
- **Dedupe:** by `infoHash` (when set) or by `streamUrl` (when set). First-wins; later duplicates dropped.
- **Parsing:**
  - `quality = parseQuality(stream.title)`
  - `sizeBytes = stream.behaviorHints?.videoSize ?? 0` (some addons set it; many don't)
  - `seeds`, `peers` not exposed by Stremio — set to 0 and **don't drop on seeds=0** for stremio source (we don't have the info). Mark `castFriendly` per `parseQuality` rules.
  - `name = stream.title || stream.name`
  - `addonOrigin` = the addon's `manifest.name`
- **Magnet reconstruction** (when `infoHash` set, no `url`):
  ```
  magnet:?xt=urn:btih:<infoHash>
         &dn=<encodeURIComponent(title)>
         &<each stream.sources[] that starts with "tracker:" → &tr=...>
  ```
  Fall back to the same hardcoded tracker list `buildMagnet()` uses in `knaben.ts` if no `sources[]` is present.
- **HTTP stream pass-through** (when `url` set):
  - Store as `streamUrl`. Don't reconstruct magnet.
  - Don't filter by codec — debrid usually serves whatever was in the original release; let `castFriendly` flag steer the user.
- **Rank:** existing `rankTorrent()` — `castFriendly > resolution > codec > seeds`. Since stremio results have `seeds = 0`, the tie-breaker stops contributing — fine.

## API endpoints

```
POST   /api/stremio/addons   body: { url: string }
  → validateAddon → if ok, append to settings.stremioAddons, return the new entry
  → 400 if URL is invalid or manifest probe fails

DELETE /api/stremio/addons/:id
  → remove from settings.stremioAddons by id

GET    /api/stremio/test/:id
  → runs searchStremioMovie("tt1375666") (Inception)
  → returns { ok, sampleCount, firstTitle?, error? }
```

## Fallback wiring (`routes/torrents.ts`)

**Movie route** — current is YTS → Knaben → TD. New:
```
YTS → Stremio (if any enabled addons & imdbId) → Knaben → TD
```

**Episode route** — current is EZTV → Knaben → TD. New:
```
EZTV → Stremio (if imdbId) → Knaben → TD
```

`tried` array gains `"stremio"`. Errors recorded per-addon — `{ source: "stremio", addonId, code: "fetch"|"timeout"|"invalid" }`. A single addon failing doesn't fail the chain.

**imdbId plumbing:** the movie search route doesn't currently pass imdbId — it accepts `title` + `year`. Add `imdbId` as a query param (client already has it from OMDb detail page); fall back to skipping Stremio if absent.

## Phase 5 — HTTP stream pipeline

### Audit-driven design decision

The Chromecast / web-player pipeline today assumes every `streamPath` is a local path served by us (`cast.ts:70` builds `http://<LAN_IP>:3000<streamPath>`). HTTP streams from debrid CDNs (Real-Debrid, AllDebrid, Premiumize) are externally hosted — that assumption breaks.

Three patterns considered:

| Approach | Pros | Cons |
|---|---|---|
| **(A) Direct passthrough** — pass external URL to Chromecast/`<video>` unchanged | Lowest latency; one copy of stream over LAN; cheapest to ship | No server-side transcode; HEVC may fail on older Chromecasts; no history tracking |
| (B) Server-side proxy — pipe external URL through `/stream/proxy/<token>` | Unified URL contract; transcode capability; history tracking | Doubles LAN bandwidth (CDN→laptop→Chromecast); ~100 Mbps for 4K |
| (C) Hybrid — A by default, B when user toggles transcode | Best of both | Adds complexity now for an unproven user need |

**Decision: ship (A) for v1.** Reasoning:
- Streams from debrid CDNs are CORS-friendly and Chromecast-friendly in the common case.
- Doubling LAN bandwidth for proxy mode is real — 4K HDR can saturate older networks.
- Most users will pick a 1080p/x264 result anyway (Stremio almost always returns multiple variants of the same release); HEVC-on-non-Ultra-Chromecast is rare in practice.
- The transcode pipeline currently takes a webtorrent `Readable`, not a URL — building a URL-input ffmpeg pipeline is real work that doesn't have to block this phase.

### Server changes

**`/api/torrent/start` — new `streamUrl` body branch:**

```ts
if (body.streamUrl) {
  // External HTTP stream — bypass webtorrent entirely.
  if (!/^https?:\/\//.test(body.streamUrl)) {
    return reply.code(400).send({ error: "streamUrl must be http(s)" });
  }
  return {
    infoHash: null,
    videoName: body.title ?? "stream",
    videoLength: 0,                // unknown; CDN tells the client via Content-Length
    streamUrl: body.streamUrl,     // ABSOLUTE URL — cast.ts must detect and pass through
    videoCodec: body.videoCodec ?? null,
    transcodable: false,
  };
}
```

No `setMeta()` call (no infoHash to key on). HTTP-stream sessions are intentionally ephemeral.

**`/api/cast/play` — detect absolute URLs in `streamPath`:**

```ts
const isAbsolute = /^https?:\/\//i.test(streamPath);
const streamUrl = isAbsolute
  ? streamPath
  : `http://${ip}:${config.port}${streamPath}`;
```

The LAN IP lookup is irrelevant when `streamPath` is absolute — but harmless to compute. Keep the check; it still applies to the magnet path.

**History tracking:** `infoHashFromStreamPath()` returns `null` for absolute URLs. The `if (infoHash) { … appendHistory … }` block is already null-guarded — HTTP streams skip history. Acceptable for v1; add a TODO comment.

### Web client changes

`/api/torrent/start` invocation:
- If picked result has `source === "stremio"` AND `streamUrl` is set → POST `{ streamUrl, source: "stremio", title, posterUrl, imdbId, … }`.
- Else if `source === "stremio"` AND only `magnet` → POST `{ magnet, source: "stremio", … }` (existing magnet path).
- Else existing routing for yts/eztv/knaben/torrentday.

Cast/play invocation: send `streamPath` as the URL returned by `/api/torrent/start`. The server-side detector handles both absolute and relative.

### Out of scope for Phase 5

- Server-side transcode for HTTP streams (ffmpeg URL input). Future enhancement.
- Per-stream-URL history entries (would need a synthetic ID).
- Persistent active-stream tracking for HTTP streams in `/api/torrents` (HTTP streams don't appear in the active downloads list).
- Re-querying the addon at cast time for a fresh URL if the stored one is expired. Listed as future enhancement.

## Adapter fixes bundled into Phase 5

The audit surfaced seven small issues that should land alongside the Phase 5 pipeline work — same surface area, minimal risk:

1. **Validate tracker schemes in `buildMagnetFromStream`.** Only keep `sources[]` entries that, after stripping `tracker:`, start with `udp://`, `http://`, or `https://`. Drops malformed entries silently.

2. **Boost HTTP-stream results in the rank tie-breaker.** In `fanOut`, after `deduped.sort(rankTorrent)`, do a stable secondary sort that pushes entries with `streamUrl` above entries without, within the same quality bucket. Instant > P2P.

3. **`validateAddon` checks `idPrefixes`.** If `manifest.idPrefixes` is present and doesn't include `"tt"`, add a non-fatal warning to the return: `{ ok: true, manifest, warning: "addon may not support IMDb-keyed (tt…) lookups" }`. UI displays it on add.

4. **`validateAddon` checks `behaviorHints.configurationRequired`.** If set + true on the supplied URL, return: `{ ok: true, manifest, warning: "addon requires configuration — visit the addon's setup page to get a personalised URL" }`.

5. **`chmod 600` the settings file.** In `services/settings.ts`, after each `writeFile`/`rename`, call `fs.chmod(PATH, 0o600)`. Covers the existing TD/proxy creds retroactively. One-liner with a comment.

6. **`castFriendly` exposed prominently for Stremio results in UI.** Phase 7 task — flag here so it doesn't get forgotten. When a Stremio result is non-castFriendly, the Cast button shows a confirm dialog: "This release may not play on older Chromecasts — pick an x264 variant instead?"

7. **URL-expiry error UI.** When `/api/cast/play` errors mid-stream from an external URL (typically HTTP 410/404), surface a clear toast: "The stream URL has expired — search again to refresh." Soft requirement for Phase 5; can land with Phase 7.

These are tracked individually in tasks.md.

## `services/torrent.ts` — `fileIdx` support

Current `startTorrent` picks the largest video file via `pickVideoFile()`. Extend:

```ts
export async function startTorrent(
  input: string | Buffer,
  opts?: { fileIdx?: number },
): Promise<TorrentSession>;
```

When `fileIdx` provided and within range, select that file instead of `pickVideoFile()`. Same `file.deselect()` for other files in the torrent.

## UI changes — Settings → Indexers → Stremio Addons

Sits below the TorrentDay subsection:

- **Header:** "Stremio Addons" + help copy:  
  > Paste a Stremio addon URL to pull in its indexer coverage. Most popular: **Torrentio** (set up with optional Real-Debrid for instant streams). Self-host or use a personalised URL if rate-limited.
- **Add row:** text input ("Addon manifest URL — e.g. https://torrentio.strem.fun/.../manifest.json") + "Add" button. On Add: POST to `/api/stremio/addons`. Display the validation result inline ("✓ Added: Torrentio" or "✗ Couldn't reach addon").
- **List of installed addons** (vertical stack of cards):
  - Addon name (from manifest, e.g. "Torrentio") + truncated URL.
  - Enable toggle (save-on-change).
  - **Test** button — hits `/api/stremio/test/:id`; inline result (count + first title or error).
  - **Remove** button (with confirm).
- **Warning copy** below the list:
  > ⚠️ Addon URLs can contain personalised secrets (e.g. Real-Debrid API keys). Treat them like passwords — don't share screenshots.

## Logging & redaction

- Log `stremio: search imdb=<id> via=<N addons>` — never log full addon URLs (they may contain secrets).
- Per-addon failures: `stremio: addon <addonName> failed — <code>` (use the manifest.name, not the URL).
- On `/api/stremio/addons` POST: log URL host only, not the path.

## Failure modes

| Scenario | Behaviour |
|---|---|
| Addon URL unreachable on add | `POST /api/stremio/addons` returns 400 with clear error |
| Manifest doesn't include `"stream"` resource | 400: "addon doesn't expose stream resource" |
| Addon enabled but one fetch fails | `tried` gets `"stremio"`, errors array gets that addon's failure, others still contribute |
| All addons fail / no imdbId | Stremio skipped silently (`tried` doesn't include "stremio") |
| HTTP stream URL 404 mid-playback | Cast pipeline surfaces error; user picks another result. URL was time-limited (debrid). |
| Two addons return same `infoHash` | First-wins dedupe; the duplicate is dropped |

## Tests

`apps/server/src/services/__tests__/stremio.test.ts`:
- Fixture: valid manifest → `validateAddon` returns `ok: true`.
- Fixture: manifest missing `"stream"` → returns `ok: false` with clear error.
- Fixture: stream response with mixed `infoHash` + `url` streams → parser maps both shapes correctly, `streamUrl` set for HTTP shape, magnet reconstructed for hash shape.
- Dedupe by `infoHash` across two fake addons.
- `Promise.allSettled` semantics: one addon throws, the other returns 3 — result list has 3 items.
- URL normalisation: trailing `/manifest.json` stripped, trailing slash stripped.

`apps/server/src/services/__tests__/settings.test.ts` additions:
- `stremioAddons` round-trip; URL validation; `id` server-generated and immutable from client.

Manual smoke checklist in tasks.md:
- Add Torrentio (no debrid) → search a popular movie → Stremio results appear in `tried`.
- Add a personalised Torrentio-RD URL → search → `streamUrl` results appear → casting plays without webtorrent.
- Toggle addon off → no Stremio results.
- Remove addon → list updates.

## Dependencies to add

None — `cheerio` not needed (Stremio is JSON). Existing `lru-cache` is enough.

## Out of scope (future)

- `catalog` / `meta` Stremio resources (would let us pull poster/trailer from addons too; OMDb already covers this).
- Exposing cratebuddy AS a Stremio addon (the other half of the protocol).
- Auto-discovery of community addon lists.
- Per-addon proxy URL (single `proxyEnabled.stremio` flag applies to all).
- Subtitle resource (`/subtitles/...`) — OpenSubtitles already integrated.
