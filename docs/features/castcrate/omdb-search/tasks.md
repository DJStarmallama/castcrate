# omdb-search — Tasks

**Last updated:** 2026-05-09
**Progress:** Implemented (retrospective)

## Original implementation (completed)

- [x] OMDb adapter (`services/omdb.ts`) with LRU(500, 1h) cache
- [x] Routes: `/api/search`, `/api/movies/:imdbId`, `/api/series/:imdbId`, `/api/series/:imdbId/seasons/:season`
- [x] Error mapping (401 invalid key, 502 DNS/network, silent empty for "Too many" / "Not found")
- [x] Movie + series parallel + interleaved search when no type filter
- [x] Web: debounced search input (300ms, ≥3 chars)
- [x] Web: card grid + responsive layout
- [x] Web: movie detail modal + series detail modal with season selector
- [x] React Query for fetch/dedupe/staleness
- [x] IMDb ID validation `/^tt\d+$/`

## Future enhancements

### High priority
- [ ] Vitest fixtures for `omdb.ts` (search, detail, error paths)
- [ ] Replace hardcoded "YTS" copy in `TorrentPicker` with dynamic source list

### Medium priority
- [ ] Surface OMDb quota / key validity in `/api/system/check` UI
- [ ] localStorage-backed recent searches
- [ ] Prefetch detail on card hover (`onMouseEnter` → `queryClient.prefetchQuery`)

### Low priority
- [ ] Episode-level overviews (alt source — TheTVDB / TVmaze)
- [ ] Mark `OMDB_API_KEY` missing more obviously than 503 toast
