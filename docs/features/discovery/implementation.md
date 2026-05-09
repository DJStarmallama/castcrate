# Feature: discovery — trailers, trending, recommendations

**Status:** Phases α + β shipped (trailers + Discover tab); γ pending
**Created:** 2026-05-10
**Goal:** Replace the "what should I watch tonight?" decision loop that Netflix/Prime/Stan currently solve. Trending lists per-platform per-region, fast trailer previews, "more like this" recommendations.

## Decisions

- **TMDB was the original choice but their site was returning 502s during signup** — could not register an account. Skipped.
- **JustWatch's unofficial GraphQL endpoint** is the planned data source for trending + per-platform + recommendations. Their public website uses it, so it's stable enough for personal-use. Implementation deferred to Phase β.
- **YouTube via HTML search-page scrape** is the trailer source. Zero auth, zero quota — server fetches `youtube.com/results?search_query=…`, parses the first `videoRenderer.videoId` (skips Shorts and ads), embeds via `youtube.com/embed/{id}`. Caches 24h.
- **Region:** AU. Platform list: Netflix, Prime, Stan, Binge, Disney+, Paramount+, Apple TV+ (Australian streamers, not US).

## Phases

### Phase α — Trailers in the detail modal ✅

Lightest possible win: a "Trailer" button on Movie + Series detail modals. Opens an inline iframe that takes over the modal interior. Back button returns to detail.

- `apps/server/src/services/youtube.ts` — search scrape, LRU(500, 24h)
- `apps/server/src/routes/trailers.ts` — `GET /api/trailer?title=&year=` returns `{ videoId, embedUrl, searchUrl }`. 200 always; falls back to `searchUrl` when no embeddable result.
- `apps/web/src/components/TrailerView.tsx` — inline iframe with autoplay, "Search on YouTube ↗" fallback when no result.
- `MovieDetail.tsx` / `SeriesDetail.tsx` — Trailer button + state, swap body for `<TrailerView>`.

### Phase β — Discover tab ✅

When the search bar is empty, the home view shows the Discover layout:

- Genre filter pills along the top — `All / Documentary / History / Music & Musical / Mystery & Thriller / Fantasy / Horror / Western / Science-Fiction / Action & Adventure / Comedy / Crime / Sport / War & Military / Reality TV / Drama / Kids & Family / Romance / Animation` (19 genres direct from JustWatch). Pick one → every row below filters by it.
- Horizontal-scrolling rows:
  - Trending this week (no provider filter)
  - Popular on Netflix / Stan / BINGE / Prime Video / Disney+ / Paramount+ / Apple TV+ (all AU)
- Click any poster → existing detail modal flow (uses the IMDb ID from JustWatch's `externalIds`). Posters without an IMDb match are dimmed and disabled.

**Data layer** — `services/justwatch.ts`:
- `getPopularTitles({ country, packages?, genres?, objectTypes?, first })` — TitleFilter-shaped GraphQL query against `apis.justwatch.com/graphql`. LRU(200, 1h).
- `getGenres()` — 19 genres, LRU(1, 24h).
- Poster URLs are templates `/poster/<id>/{profile}/<slug>.{format}` — adapter substitutes `s276` + `webp` server-side so the client gets ready-to-use URLs.

**Routes:**
- `GET /api/discover/popular?provider=&genre=&type=&limit=`
- `GET /api/discover/genres`
- `GET /api/discover/providers` — AU streamer list (Netflix, Stan, BINGE, Prime, Disney+, Paramount+, Apple TV+).

**Provider shortNames** (JustWatch internal): `nfx stn bng prv dnp pmp atp`.

### Phase γ — Polish (planned)

- "Available on:" provider badges on search results + Discover cards.
- Recommendations row at the bottom of the detail modal ("More like this" via JustWatch).
- Per-region UI affordances if we ever target more than AU.

## Trailers — gotchas

- **YouTube layout changes** can break `VIDEO_ID_RE`. If the regex stops matching, parse the `var ytInitialData = {...}` JSON blob instead.
- **EU consent interstitial** redirects search results to a consent page. Header `Cookie: CONSENT=YES+1` bypasses it.
- **Shorts** appear in search results as `reelItemRenderer`; the regex specifically targets `videoRenderer` so the first match is a real video.
- **No language filter on results** — searches default to English. Movies with non-English official trailers may surface alternate-language uploads. Acceptable for v1.
- **Caching nulls** matters — repeated misses for obscure titles would hammer YouTube otherwise. Wrapper `CachedEntry { id: string \| null }` is the LRU value type.

## JustWatch — gotchas

- **Schema is undocumented and could change without notice.** All field references live in `services/justwatch.ts` so churn is one file. Cache aggressively (1h LRU) so we don't hammer them.
- **No SLA, no support.** If they ever rate-limit by IP, swap in Watchmode. Adapter shape is generic enough for that swap.
- **Some titles have no `externalIds.imdbId`** — newer releases or obscure ones. Discover dims those posters and disables clicks rather than guessing.
- **Provider shortNames are JustWatch-internal** (`nfx`, `stn`, `bng`, etc.). They aren't stable identifiers across other APIs — don't leak them to consumers.
- **Filter input type is `TitleFilter`** with `packages: [String]`, `genres: [String]`, `objectTypes: [ObjectType]`. The schema is forgiving — pass null filter when no fields apply.

## Future enhancements

- [ ] Provider badges on detail modal + search results (Phase γ — show "Available on: Netflix, Stan")
- [ ] Recommendations row at bottom of detail modal (Phase γ — JustWatch `similarTitles` query)
- [ ] Multi-region support (UI to switch from AU)
- [ ] Trailer language preference
- [ ] Cache trailer embeds in IndexedDB on the client (skip server roundtrip on repeat opens)
- [ ] Trending row across **all** providers (rather than per-provider) — useful for "everyone's watching this"
- [ ] Per-genre dedicated rows (e.g. "Best comedies of 2024")
- [ ] Watch-history-aware "because you watched X" row
