# Feature: torrentday-indexer

**Status:** Spec — updated 2026-05-15 with confirmed selectors after Phase 0 recon
**Authored:** 2026-05-15
**Depends on:** `proxy-routing`

## Phase 0 findings (incorporated)

- Search URL: `GET https://www.torrentday.com/t?q=<query>` — `qf` is **search scope** (`""`, `ta`, `all`, `adv`), not a category filter.
- Categories filter via separate empty params: `?96=&q=inception` filters to Movies/4K. Useful IDs:
  - **Movies** (broad): `96` (4K), `11` (Bluray), `5` (Bluray-Full), `48` (x265), `44` (SD/x264), `21` (MP4)
  - **TV episodes** (broad): `104` (4K), `32` (Bluray), `7` (x264), `34` (x265), `26` (SD/x264)
  - Drop XviD (`1`/`2`) — old, low value.
- **Search results contain direct `.torrent` download links** — no detail-page round-trip needed. The `a.tdm-dl-cell[href^="/download.php/..."]` anchor in each row is the file URL. Killing the `fetchTorrentBlob(detailUrl)` two-step.
- Auth check: presence of `<table id="torrentTable">`. Login redirect renders a `<form action="/login.php">` instead.
- Cookie shape: `uid=<numeric>; pass=<32-char-token>`. Confirmed.

### Confirmed selectors

| Field | Selector |
|---|---|
| Result rows | `#torrentTable tbody tr` |
| Title text + detail page | `td.torrentNameInfo a.b.hv` (`/t/<id>`) |
| Category | `td.t_label img[alt]` (e.g. `alt="Movies/4K"`) |
| Size | row's `td.ac[style*="white-space:nowrap"]` |
| Seeds | `td.seedersInfo` |
| Leech | `td.leechersInfo` |
| `.torrent` URL | `a.tdm-dl-cell[href^="/download.php/"]` (relative path; prepend `https://www.torrentday.com`) |
| Freeleech | `.t_tag_free_leech` present in row |
| Metadata fallback | `.t_ctime` — "&lt;rating&gt; &lt;year&gt; &lt;genres&gt; &lt;resolution&gt; · &lt;age&gt;" |

## Executive summary

Add TorrentDay (private tracker) as the lowest-priority indexer in cratebuddy's fallback chain. Auth is via user-supplied session cookies; results are scraped from HTML search pages; **the `.torrent` download URL is embedded in each search row**, so a single HTTP request per search yields ranked results + the file URLs ready to hand to webtorrent. Disabled by default; gated on credentials + explicit toggle. Reuses the `proxy-routing` dispatcher when geoblocked.

---

## Architecture

```
RuntimeSettings
  ├── torrentDay: {
  │     enabled: boolean,
  │     uid: string | null,
  │     pass: string | null,        // both cookies — bearer equivalents
  │   }
  └── proxyEnabled.torrentday: boolean   (from proxy-routing feature)

services/torrentday.ts
  ├── searchTorrentDayMovie(title, year?)
  ├── searchTorrentDayEpisode(title, season, episode)
  ├── fetchTorrentBlob(torrentUrl) → Buffer       (called at stream-start; URL comes from search row)
  └── internal: parseSearchHtml(), buildHeaders(), assertCredentials()

routes/torrents.ts
  movie:    YTS  → empty? Knaben → empty? TD
  episode:  EZTV → empty? Knaben → empty? TD     (TD requires title)

routes/cast.ts (or wherever startTorrent is invoked)
  if result.source === "torrentday":
    blob = await fetchTorrentBlob(result.torrentUrl)   // URL was already in the search row
    session = await startTorrent(blob)
  else:
    session = await startTorrent(result.magnet)

services/torrent.ts
  startTorrent(input: string | Buffer)            // additive overload
```

## Key files

| Path | Role |
|---|---|
| `apps/server/src/services/torrentday.ts` | adapter — search + blob fetch, LRU cache, HTML parser |
| `apps/server/src/services/settings.ts` | extend `RuntimeSettings` with `torrentDay` block |
| `apps/server/src/services/torrent.ts` | accept `Buffer` in `startTorrent` |
| `apps/server/src/routes/torrents.ts` | wire TD into fallback chain after Knaben |
| `apps/server/src/lib/quality.ts` | reused as-is for parsing |
| `apps/server/src/lib/proxy.ts` | reused via `getDispatcher("torrentday")` |
| `packages/shared/src/index.ts` | `TorrentResult.source` adds `"torrentday"`; new optional `torrentUrl?: string` field (absolute URL to `.torrent`) |
| `apps/web/src/components/SettingsDialog.tsx` (or eq.) | TD enable + credential inputs + "Test connection" |
| `apps/web/src/components/StreamWarning.tsx` (new) | one-time ratio toast |
| `apps/server/src/services/__tests__/torrentday.test.ts` | parser fixtures, episode matching, redaction |

## Settings shape

```ts
export interface RuntimeSettings {
  // … existing
  torrentDay: {
    enabled: boolean;
    uid: string | null;
    pass: string | null;
  };
}
```

`sanitise()`:
- `enabled` → boolean coerce
- `uid`, `pass` → string trim, `null` if empty; reject any non-printable / whitespace

`updateSettings()`:
- `torrentDay: null` clears the whole block back to defaults
- partial merge inside the block

`getSettings()` never returns the cookie values to the web client — settings GET endpoint substitutes `"***"` if set, `null` if not. Only the server-side `getSettings()` returns the raw values.

## `services/torrentday.ts` surface

```ts
export interface TorrentDayResult extends TorrentResult {
  source: "torrentday";
  torrentUrl: string;      // absolute URL to the .torrent file (from a.tdm-dl-cell)
}

export async function searchTorrentDayMovie(
  title: string, year?: number,
): Promise<TorrentDayResult[]>;

export async function searchTorrentDayEpisode(
  title: string, season: number, episode: number,
): Promise<TorrentDayResult[]>;

export async function fetchTorrentBlob(torrentUrl: string): Promise<Buffer>;

export class TorrentDayAuthError extends Error {}     // 401/302-to-login path
export class TorrentDayDisabledError extends Error {} // missing creds or toggle off
```

### Request shape

- **Search URL:** `https://www.torrentday.com/t?q=<query>&<catId>=&<catId>=` — categories are individual empty params.
  - Movies search: append `&96=&11=&5=&48=&44=&21=` (4K, Bluray, Bluray-Full, x265, SD/x264, MP4)
  - TV episode search: append `&104=&32=&7=&34=&26=` (4K, Bluray, x264, x265, SD/x264)
- Headers:
  ```
  Cookie: uid=<uid>; pass=<pass>
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
  Accept: text/html,application/xhtml+xml
  ```
- Dispatcher: `getDispatcher("torrentday")` — proxy when enabled.
- Timeout: `AbortSignal.timeout(15000)` (slower than YTS due to HTML weight).

### Auth detection

- 200 + `<table id="torrentTable">` present → parse.
- 200 without that table (login form rendered instead) → throw `TorrentDayAuthError`.
- 302 to `/login.php` → same.
- Other status → generic fetch error, normal error path.

### HTML parsing

- Use `cheerio` (small, well-known). Add to `apps/server/package.json`.
- Selectors (pinned from fixture):
  - Rows: `#torrentTable tbody tr`
  - Title: `td.torrentNameInfo a.b.hv` — `.text()` for release name, `.attr('href')` = `/t/<id>`
  - Category label: `td.t_label img` — `alt` attribute (e.g. `"Movies/4K"`)
  - Size: row's `td.ac[style*="white-space:nowrap"]` (e.g. `"35.6 GB"`, `"366 MB"`)
  - Seeds: `td.seedersInfo` (numeric text)
  - Leech: `td.leechersInfo`
  - `.torrent` URL: `a.tdm-dl-cell` — `.attr('href')` = `/download.php/<id>/<filename>.torrent` → prepend `https://www.torrentday.com`
  - Freeleech tag: presence of `.t_tag_free_leech` in row
- Map to `TorrentDayResult` via `parseQuality()` from `lib/quality.ts` (parses resolution + codec from title).
- Category filter at request time (not client-side); XXX cats are not in the request param list.
- Drop entries with `seeds === 0`.
- Filename in `.torrent` URL has spaces — must `encodeURI()` before fetching.

### Episode matching

- Reuse `episodeMatchesTitle()` from `services/knaben.ts` (export it from there or move to `lib/quality.ts` — small refactor).
- Filter results post-parse the same way Knaben does.

### `.torrent` blob fetch

- `fetchTorrentBlob(torrentUrl)`:
  1. GET `torrentUrl` (with cookies + dispatcher). URL already absolute from the search row.
  2. Return response `arrayBuffer()` → `Buffer.from(...)`.
- Validate: `Buffer.length > 100`, first byte is `0x64` (`d` — bencode dict). If validation fails, throw — most likely TD returned an HTML error page (auth expired mid-session).
- No detail-page round-trip needed — URL is harvested directly from the search row.
- Cache: don't cache blobs (small enough to refetch; avoids stale state if TD rotates the file).

### LRU cache (search results only)

- `LRUCache({ max: 200, ttl: 1000 * 60 * 30 })` — 30 min, shorter than Knaben (private tracker, ratio matters more than cache lifetime).
- Key: `mov::${title}::${year}::${cookieHash}` / `ep::${title}::${s}::${e}::${cookieHash}`
- `cookieHash`: first 8 chars of `sha1(uid + pass)` — distinguishes accounts without storing creds in the key.

## Fallback wiring (`routes/torrents.ts`)

Movies — append after Knaben:

```ts
if (results.length === 0 && tdAvailable()) {
  tried.push("torrentday");
  try {
    results = await searchTorrentDayMovie(title, year);
  } catch (err) {
    if (err instanceof TorrentDayAuthError) errors.push({ source: "torrentday", code: "auth" });
    else errors.push({ source: "torrentday", code: "fetch" });
  }
}
```

Same shape for episodes. `tdAvailable()` returns true iff settings has `enabled === true && uid && pass`.

Errors propagate the same way EZTV/Knaben do; no special-casing.

## `startTorrent` overload

`apps/server/src/services/torrent.ts`:

```ts
export async function startTorrent(input: string | Buffer): Promise<TorrentSession>;
```

- Buffer path: `client.add(input, { path: config.downloadPath, sequentialDownload: true }, …)` — webtorrent already accepts Buffer.
- Magnet path: unchanged.
- Existing dedupe `magnet.includes(t.infoHash)` still works for the string path; add a parallel infoHash check for Buffer (parse with `parse-torrent` or the `infoHash` already exposed by webtorrent's `add` callback — check existing flow first).

## API endpoints (new)

- `GET /api/torrentday/test` → `{ ok, error?, sample? }` — runs a hardcoded query (e.g. `"big buck bunny"`) and returns the first 1-3 result titles. Used by the Settings "Test connection" button.
- `POST /api/cast/start` already exists — the route handler picks magnet vs buffer based on `result.source`. Add a small branching helper.

## UI changes

- Settings dialog → "Indexers" section:
  - Toggle: **Enable TorrentDay**
  - Inputs: **uid cookie**, **pass cookie** (password-type input, shows `***` when stored)
  - "How to get these" expander — links to TD's profile page, instructions for copying cookies from DevTools.
  - **Test connection** button — calls `/api/torrentday/test`.
  - Inline warning: "Private tracker. Streaming may affect your ratio. Use at your own risk."
- First time a `source === "torrentday"` result is streamed: one-time `<StreamWarning>` toast, dismissible, persisted in `localStorage`.

## Logging & redaction

- Never log `uid`, `pass`, or response bodies that might contain them.
- On TD search start: `torrentday: search "<query>" via=<proxy|direct>` (no creds).
- On TD auth failure: `torrentday: auth failed — refresh cookies` (no values).
- On parse failure: log selector + a single result row with sensitive bits stripped.

## Failure modes

| Scenario | Behaviour |
|---|---|
| Toggle off | TD skipped, not added to `tried` |
| Toggle on, missing cookies | TD skipped, `tried` includes `"torrentday"` with `code: "auth"` error |
| Cookies expired | `TorrentDayAuthError` → 502 if last in chain, else just logged |
| HTML structure changed | Parser returns `[]`, logged with sample HTML snippet (cookies redacted) |
| `.torrent` blob fails to parse | Stream-start fails with clear error; user can pick another result |
| Geoblocked, proxy not enabled | fetch ECONNREFUSED / timeout → standard error |

## Tests

- `torrentday.test.ts`
  - Fixture: captured search page HTML (real TD page, sanitised) → parser yields N results with expected fields.
  - Fixture: captured login-redirect HTML → `searchTorrentDayMovie` throws `TorrentDayAuthError`.
  - Episode matcher reuses Knaben tests (move tests to `lib/quality.test.ts` if matcher relocates).
  - Cookie hash determinism (same uid+pass → same hash; different → different).
- `settings.test.ts` — `torrentDay` block round-trips; `uid`/`pass` masked in API GET.
- Manual smoke checklist in tasks.md.

## Dependencies to add

- `cheerio` (~~500KB but tree-shakes; well-supported)
- `parse-torrent` (already transitively present via webtorrent? — verify; only needed if we have to derive infoHash from a Buffer for dedupe).

## Out of scope (future)

- TD freeleech detection / preference.
- Downloading subtitle packs / NFO files.
- Auto-refresh cookies via login flow (would require handling captcha).
- Generalising to other private trackers via a common `PrivateTrackerAdapter` interface — wait until we have at least 2 in production before extracting.
