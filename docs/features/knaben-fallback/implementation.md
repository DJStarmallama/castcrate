# Feature: knaben-fallback — Phase 9 (Retrospective)

**Status:** Implemented
**Documented:** 2026-05-09
**Phase:** 9 — most recent feature

## Executive summary

Knaben is a torrent **aggregator** invoked as a last-resort indexer when YTS (movies) or EZTV (TV) return zero results. It hits `api.knaben.org/v1` with a free-text query; results conform to the same `TorrentResult` shape, with a special `episodeMatchesTitle()` regex covering the awkward forms (`S1E5`, `1x5`, `Season 1 Episode 5`) older releases use.

The phase also ships a **DNS bypass** in `lib/dns.ts` — a monkey-patch on Node's `dns.lookup()` that resolves indexer hostnames via Cloudflare (1.1.1.1/1.0.0.1) before falling back to the OS resolver. Mitigates ISP-level NXDOMAIN blocks; doesn't help if the ISP intercepts UDP:53 traffic itself (requires VPN).

Recent commit `1d279aa` switched the API host from `api.knaben.eu` (now 301) to `api.knaben.org`, taught the magnet extractor to accept `magnetUrl` (newer field), and added the non-zero-padded S1E5 form to the matcher.

---

## Architecture

```
GET /api/search/torrents?title&year     ──▶ try YTS  ─empty?─▶ try Knaben(movie)
GET /api/search/torrents/episode?...    ──▶ try EZTV ─empty AND title?─▶ try Knaben(episode)

response: { … , tried: ["yts", "knaben"] }   (or 502 if all errored)

DNS bypass (always-on by default)
  setupDnsBypass() at boot in apps/server/src/index.ts
    └── monkey-patches dns.lookup
          ├── on IPv4 lookup: dns.resolve4 via custom upstreams (1.1.1.1, 1.0.0.1)
          ├── upstream miss/error → fall through to OS resolver
          └── IPv6 lookup → original resolver
```

## Key files

| Path | Role |
|---|---|
| `apps/server/src/services/knaben.ts` | adapter — `searchKnabenMovie()`, `searchKnabenEpisode()`, `episodeMatchesTitle()`, `magnetFor()`, `buildMagnet()`, LRU(200, 1h) |
| `apps/server/src/lib/dns.ts` | `setupDnsBypass()` — monkey-patch `dns.lookup` via custom upstreams |
| `apps/server/src/routes/torrents.ts` | fallback wiring on `/api/search/torrents` (movies) and `/api/search/torrents/episode` (TV) |
| `apps/server/src/index.ts` | calls `setupDnsBypass()` at startup |
| `apps/server/src/lib/quality.ts` | shared parser (resolution + codec) |
| `apps/web/src/lib/api.ts` | `searchEpisodeTorrents(title)` passes optional `&title=` |
| `apps/web/src/components/EpisodePicker.tsx` | renders `tried` sources in empty state, `extractTried()` parses error messages too |
| `packages/shared/src/index.ts` | `TorrentResult.source` extended to `"yts" \| "eztv" \| "knaben"` |
| `apps/server/src/services/__tests__/knaben.test.ts` | regex coverage (S01E05, s01e05, 1x05, 1x5, "Season 1 Episode 5", boundary cases) |

## Knaben adapter

- **Endpoint.** `${KNABEN_BASE_URL}/v1` — default `https://api.knaben.org`. Previous default `api.knaben.eu` is dead; switched in commit `1d279aa`.
- **Body.**
  ```json
  {
    "query": "<series title S01E05>"  or  "<movie title year>",
    "search_type": "score",
    "search_field": "title",
    "size": 30,
    "hide_xxx": true,
    "order_by": "seeders",
    "order_direction": "desc"
  }
  ```
- **Response field handling.** Knaben returns hits with possibly any of `magnetUrl`, `magnet`, or just `hash`. `magnetFor()` prefers in that order; if only the hash is present, `buildMagnet(hash)` reconstructs a magnet with 6 hardcoded trackers.
- **TV vs movie.**
  - `searchKnabenMovie(title, year?)` — passes title + year, no episode filter.
  - `searchKnabenEpisode(seriesTitle, season, episode)` — accepts a hit if (a) Knaben tagged the season/episode in the response, or (b) `episodeMatchesTitle()` matches the title string.
- **`episodeMatchesTitle()`.** Builds 5 regexes per call, all `\b`-bounded, case-insensitive:
  - `S01E05` (zero-padded)
  - `S1E5` (non-zero-padded — added in `1d279aa`)
  - `1x05` (alt zero-padded)
  - `1x5` (alt non-zero-padded — added in `1d279aa`)
  - `Season 1 Episode 5` (verbose)
- **Quality.** Shared `parseQuality()` from `lib/quality.ts`. xvid filtered out by `toResult()`. Ranking: castFriendly > resolution > codec > seeds.
- **Cache.** LRU(200, 1h). Keys: `mov::${title.toLowerCase()}::${year ?? ""}` or `ep::${title.toLowerCase()}::${season}::${episode}`.

## Fallback wiring (`routes/torrents.ts`)

**Movie search:**
1. Try YTS.
2. If YTS returns empty (any `length === 0` after rank/filter), try Knaben.
3. If both error → 502 with `{ tried: ["yts", "knaben"], errors }`.
4. Otherwise return results + `tried` array.

**TV episode search:**
1. Try EZTV (numeric IMDb ID, batched).
2. If EZTV returns empty *and* `title` query param is present → try Knaben (Knaben searches by string; without a title we can't query).
3. If both empty + errors → 502 with the `tried` array.
4. Otherwise return `{ episode, seasonPacks, tried }`.

**Notable absences:**
- No "season pack" path through Knaben — only `searchKnabenEpisode`. Season-pack coverage stays with EZTV.
- No timeout-based fallback (only empty-result fallback). If YTS is slow but eventually returns 0 results, the full latency hits the user.

## DNS bypass (`lib/dns.ts`)

```ts
// pseudo
const original = dns.lookup;
dns.setServers(opts.upstreams);    // ["1.1.1.1", "1.0.0.1"] by default
dns.lookup = (hostname, opts, cb) => {
  if (opts?.family === 6) return original(...);     // skip IPv6
  resolve4(hostname, (err, addrs) => {
    if (err || !addrs?.length) return original(...); // fall through
    cb(null, addrs[0], 4);
  });
};
```

- **Activation.** Always-on by default. Disable with `DNS_BYPASS=false`.
- **Upstreams.** `DNS_UPSTREAMS` env (CSV). Default `1.1.1.1,1.0.0.1` (Cloudflare).
- **Scope.** Global — affects every `fetch`, `net.connect`, `undici` call in the process. No per-host targeting.
- **Failure mode.** If the custom upstreams fail (network down, port 53 intercepted), fall through to the OS resolver. Preserves `/etc/hosts` and mDNS.
- **What it doesn't fix.** ISP-level UDP:53 interception. Only a VPN escapes that.

## S1E5 fix (commit `1d279aa`)

Older or niche releases sometimes drop zero-padding (`Show.S1E5.DVDRip.avi`). The original regex set only matched `S01E05`, silently filtering out valid torrents. The fix adds two more patterns:

```ts
new RegExp(`\\bS${seasonRaw}E${episodeRaw}\\b`, "i"),  // S1E5
new RegExp(`\\b${season}x${episodeRaw}\\b`, "i"),       // 1x5
```

The `\\b` boundaries are critical to avoid false positives on `S01E50` matching `S01E5`. Test (`knaben.test.ts`) explicitly covers this case.

## Tests

`knaben.test.ts` covers `episodeMatchesTitle()` only:

- ✓ `S01E05` zero-padded
- ✓ Lowercase `s01e05`
- ✓ `1x05`
- ✓ `1x5` (non-zero-padded — added in `1d279aa`)
- ✓ `Season 1 Episode 5` verbose
- ✓ Boundary: `S01E50` ≠ `S01E5`
- ✓ Wrong-season rejection (`S02E05` for season 1 query)

No tests for: API error paths, malformed JSON, magnet reconstruction, cache, DNS bypass behaviour.

---

## Gotchas

- **No env example.** `KNABEN_BASE_URL`, `DNS_BYPASS`, `DNS_UPSTREAMS` aren't in `.env.example`. Users discover them only by reading code.
- **No rate limiting.** No 429 handling, no exponential backoff. Hammering Knaben with rapid searches will eventually be throttled.
- **DNS bypass is global, not per-indexer.** All hostname lookups go through Cloudflare first. If you specifically want to leave OMDb on the OS resolver, you can't.
- **No automatic indexer rotation.** If `api.knaben.org` is also seized, only env override + redeploy fixes it. Same as YTS.
- **Magnet reconstruction depends on hardcoded trackers.** If all 6 are dead, the reconstructed magnet has no peer source.
- **No season-pack search through Knaben.** EZTV is the only season-pack source; Knaben fills the per-episode gap only.
- **Title-required for episode fallback.** The route checks for `title` query before invoking Knaben. The web client passes it now (Phase 9 commit) — but a third-party caller might not.
- **Episode-tag silent skip.** `if (!tagged && !episodeMatchesTitle(…)) continue` — if Knaben doesn't tag the season/episode and the title doesn't match any of the 5 regexes, the hit is dropped silently. No fuzzy-match fallback.
- **DNS bypass is best-effort.** If the network blocks port 53 to public resolvers, this does nothing — README already mentions VPN.

## Future enhancements

### High priority
- [ ] Document `KNABEN_BASE_URL`, `DNS_BYPASS`, `DNS_UPSTREAMS` in `.env.example`
- [ ] 429 handling + exponential backoff on Knaben
- [ ] Vitest fixtures for Knaben API responses (success, empty, error)

### Medium priority
- [ ] Knaben season-pack search path (in case EZTV is also down)
- [ ] Per-indexer DNS-bypass scoping (only when targeted host needs it)
- [ ] Fuzzy title match fallback when episode tag + regex both fail
- [ ] Surface "fallback used" hint in UI (currently `tried` array is consumed by EmptyResults only)

### Low priority
- [ ] Configurable tracker list for `buildMagnet` reconstruction
- [ ] Prefetch Knaben results in parallel with YTS/EZTV for faster fallback when primary is empty
- [ ] Telemetry on which indexer served each magnet (helps prioritise rotation work)
