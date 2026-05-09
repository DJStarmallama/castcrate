# Feature: discovery — trailers, trending, recommendations

**Status:** Phase α shipped (trailers); β + γ pending
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

### Phase β — Discover tab (planned)

New top-level "Discover" view with horizontal-scrolling rows:

- Trending this week (region: AU)
- Popular on Netflix AU
- Popular on Stan AU
- Popular on Binge AU
- Popular on Prime AU
- Popular on Disney+ AU
- Popular on Paramount+ AU
- Popular on Apple TV+ AU

Data: JustWatch GraphQL adapter (`services/justwatch.ts`) + cache. Click a poster → existing detail modal flow.

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

## Future enhancements

- [ ] JustWatch adapter (Phase β prerequisite)
- [ ] Discover tab UI (Phase β)
- [ ] Provider badges (Phase γ)
- [ ] Recommendations row (Phase γ)
- [ ] Multi-region support (UI to switch from AU)
- [ ] Trailer language preference
- [ ] Cache trailer embeds in IndexedDB on the client (skip server roundtrip on repeat opens)
