# omdb-search — Context

**Last updated:** 2026-05-09
**Status:** Implemented (retrospective doc)

## Status

- Search debounced at 300ms, fires at ≥3 chars
- Movie + series interleaved when type is unfiltered
- LRU cache 500/1h on the server side
- Modals route to torrent/episode pickers downstream
- No unit tests for the adapter

## Key files

- `apps/server/src/services/omdb.ts` — adapter, cache, error mapping
- `apps/server/src/routes/movies.ts` — search, detail, season episodes endpoints
- `apps/web/src/lib/api.ts` — client wrapper, `ApiError`
- `apps/web/src/components/{SearchBar,ResultsGrid,MovieCard,MovieDetail,SeriesDetail}.tsx`
- `apps/web/src/hooks/useDebounced.ts`
- `apps/web/src/App.tsx` — search state, type filter, modal routing

## Decisions

- **OMDb over TMDB.** Easier API key; simpler responses; sufficient for v1.
- **3-char floor.** OMDb returns "Too many results" below that — wastes quota.
- **Server-side caching only.** Client uses TanStack Query for staleness; server LRU absorbs duplicate hits across browsers/sessions.
- **Interleaving over separate sections.** When no type filter, movies + series alternate so neither dominates the grid.
- **Strip apikey from cache key.** Defense in depth; same-process so it shouldn't matter, but cheap.

## Gotchas

- **OMDb is HTTP, not HTTPS.** Plaintext blocking isn't fixable by DNS bypass.
- **Search payload is minimal.** No rating/overview until the detail fetch — cards show year + TV badge only.
- **Episode overviews are empty.** OMDb season response doesn't include them.
- **Hardcoded "YTS" copy in `TorrentPicker`** doesn't reflect Phase 9 knaben fallback.
- **Adapter is the same one used by Phase 5.** Don't refactor the cache keys without checking series detail / season-episode behaviour.

## Epic Review Findings (2026-08-09)

- 🔗 **`type` filter is load-bearing in the OMDb cache key but undocumented** — spans omdb-search ↔ cast-controls ↔ discovery — `services/omdb.ts:54` keys on `JSON.stringify(params)` including `type`; extract typed `cacheKey(q, type?)` helper. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 💳 **Zero automated test coverage, error mapping is stringly-typed** — no fixtures for 401/502/silent-empty; 3-char search floor is a magic constant. Add recorded fixtures + tests; expose OMDb quota in `/api/system/check`. `/review-feature castcrate/omdb-search`. (See epic-overview.md → Tech Debt / Findings.)

_Recorded by /review-epic castcrate on 2026-08-09._
