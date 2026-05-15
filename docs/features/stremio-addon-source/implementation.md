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

## `/api/torrent/start` — HTTP stream branch

Today the route accepts `{ magnet | torrentUrl }`. Add `{ streamUrl }` shape:

```ts
if (body.streamUrl) {
  // Skip webtorrent entirely. Validate it's https/http.
  // Return immediately with a synthetic session:
  return reply.send({
    streamUrl: body.streamUrl,      // play directly
    infoHash: null,
    name: body.title ?? "stream",
    ready: true,
    transcodable: false,            // can't ffmpeg-transcode opaque CDN URLs cheaply
  });
}
```

**Web client change:** when selecting a result with `source === "stremio"` and `streamUrl`, send `{ streamUrl }` to `/api/torrent/start`. The cast/play handler points the player / Chromecast directly at `streamUrl`.

**Caveat — Chromecast and CORS:** Chromecast loads URLs directly from the network. If the debrid URL doesn't serve with permissive CORS (it usually does — these are CDN endpoints), casting works. If not, we'd need to proxy through `/stream/proxy?url=...`. Defer that until a real failure surfaces; add a TODO note.

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
