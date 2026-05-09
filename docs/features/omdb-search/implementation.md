# Feature: omdb-search — Phase 1 (Retrospective)

**Status:** Implemented
**Documented:** 2026-05-09
**Phase:** 1

## Executive summary

Title search backed by OMDb (not TMDB as originally drafted in `castcrate-plan.md`). The server adapter (`services/omdb.ts`) wraps OMDb's HTTP API with a 500-entry / 1-hour LRU cache and translates results into the shared `MovieSearchResult` / `MovieDetails` / `SeriesDetails` shapes. The web app debounces the search input (300ms, ≥3 chars), dispatches via TanStack Query with `staleTime: 60s`, and renders a movie/series card grid plus a modal detail panel. Movies feed into the torrent picker (Phase 2); series feed into the season/episode picker (Phase 5).

The same adapter is reused by Phase 5 for series detail and per-season episode lookups.

---

## Architecture

```
SearchBar.tsx ──debounced──▶ App.tsx
                              │
                              │ useQuery(["search", q, type])
                              ▼
              GET /api/search?q=…&type=…
                              │
                              ▼
              routes/movies.ts ─▶ services/omdb.ts
                              │
                              │   LRU(500, 1h) → fetch http://www.omdbapi.com/
                              ▼
                  MovieSearchResult[] / MovieDetails / SeriesDetails
```

When `type` is omitted, `omdb.search()` runs movie + series queries in parallel and **interleaves** results (alternating by index) so neither type crowds the other.

## Key files

| Path | Role |
|---|---|
| `apps/server/src/services/omdb.ts` | OMDb adapter — `omdbFetch<T>`, `search()`, `getMovieDetails()`, `getSeriesDetails()`, `getSeasonEpisodes()`, LRU cache, error mapping |
| `apps/server/src/routes/movies.ts` | `GET /api/search`, `GET /api/movies/:imdbId`, `GET /api/series/:imdbId`, `GET /api/series/:imdbId/seasons/:season` |
| `apps/web/src/lib/api.ts` | typed client wrapper, `ApiError` |
| `apps/web/src/components/SearchBar.tsx` | `<input type="search">`, Cmd+K hint |
| `apps/web/src/components/ResultsGrid.tsx` | responsive grid (2 cols mobile → 6 cols XL) |
| `apps/web/src/components/MovieCard.tsx` | poster + title + year + rating + "TV" badge |
| `apps/web/src/components/MovieDetail.tsx` | modal — poster, plot, genres, cast, "Find & Cast" CTA |
| `apps/web/src/components/SeriesDetail.tsx` | modal — series metadata + season selector + episodes grid |
| `apps/web/src/hooks/useDebounced.ts` | 300ms debounce |
| `apps/web/src/App.tsx` | search state, type filter, modal routing |

## OMDb adapter behaviour

- **Endpoint.** `http://www.omdbapi.com/` (HTTP, not HTTPS — that's OMDb's actual endpoint).
- **Cache key.** `JSON.stringify(params)` with `apikey` stripped (cache poisoning hygiene).
- **Cache.** LRU, max 500, TTL 60min. Shared across search + detail + season-episode calls.
- **Error mapping.**
  - DNS errors (`ENOTFOUND`, `EAI_AGAIN`) → 502
  - `Response: "False"` with `"invalid api key"` → 401
  - `"not found"` / `"too many results"` → silently empty (allows mid-typing)
  - Other `Response: "False"` → 502
- **IMDb ID validation.** `/^tt\d+$/` — anything else short-circuits to 400.
- **Search interleaving.** When no `type` is passed, runs both `s=…&type=movie` and `s=…&type=series` in parallel, then interleaves (`movie[0], series[0], movie[1], …`).
- **Search vs detail.** Search returns minimal data (no rating, no overview); detail fills those in.

## Web flow

1. User types in `SearchBar` → `useDebounced(query, 300)`.
2. Query enabled when debounced length ≥ 3 chars (lines 61–63 of `App.tsx`: "OMDb requires ≥3 chars… either errors with 'Too many results' or wastes our quota").
3. `useQuery(["search", debounced, typeFilter])` fetches `/api/search`.
4. `ResultsGrid` renders `MovieCard[]`. Series get a "TV" badge.
5. Click a card → `selected: { imdbId, type }`; modal opens.
6. Modal fetches detail via `useQuery(["movie", imdbId])` or `["series", imdbId])`.
7. Movie modal: "Find & Cast" → opens `TorrentPicker` (Phase 2). Series modal: season selector → episodes grid → `EpisodePicker` (Phase 5).

## Cross-cutting

- **Reused by Phase 5.** `getSeriesDetails()`, `getSeasonEpisodes()` are TV-only entry points for the same adapter.
- **Reused by torrent search.** Phase 2 uses the movie title + year from OMDb metadata to query YTS.
- **Type filter.** Wired in Phase 7 — `App.tsx` passes `typeFilter ∈ {"all", "movie", "series"}` to the query, and the server collapses to a single OMDb call when type is `"movie"` or `"series"`.

## Tests

None. The adapter has no Vitest coverage (search, detail, caching, error mapping). Live API dependency is the integration risk; recorded fixtures would be appropriate.

---

## Gotchas

- **OMDb is HTTP-only.** Some networks block plaintext HTTP — DNS bypass (Phase 9) doesn't help here, only a real proxy/VPN does.
- **3-char minimum is hardcoded.** `App.tsx` won't fire searches below 3 chars; OMDb returns "Too many results" otherwise. UI shows "Keep typing" hint.
- **Search results are minimal.** No rating or overview until the detail call lands. Cards show year + "TV" badge only.
- **`SeriesEpisode.overview` is always empty.** OMDb's per-season response doesn't include episode plot summaries; the field is reserved for a richer source.
- **Hardcoded YTS-only message in `TorrentPicker`.** "No compatible (1080p / 720p · x264) torrents found on YTS" — doesn't reflect the Phase 9 fallback to Knaben.
- **Disabled "Find & Cast" placeholder removed.** Was a Phase 1 placeholder ("Available in next phase"); now wired through.

## Future enhancements

### High priority
- [ ] Vitest fixtures for `omdb.ts` (search, detail, error mapping, caching)
- [ ] Update `TorrentPicker` "no results" copy to reflect knaben fallback

### Medium priority
- [ ] Surface OMDb quota usage in `/api/system/check`
- [ ] Persist recent searches across reloads (localStorage)
- [ ] Prefetch detail on card hover (cheap with React Query)

### Low priority
- [ ] Show episode overviews when available (alt source)
- [ ] Honour `Content-Encoding: gzip` if OMDb starts returning it
