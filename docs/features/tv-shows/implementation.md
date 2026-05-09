# Feature: tv-shows — Phase 5 (Retrospective)

**Status:** Implemented
**Documented:** 2026-05-09
**Phase:** 5

## Executive summary

Adds first-class TV show support: search returns movies + series side by side, series open into a season picker, then an episode picker, then an episode-torrent picker (EZTV primary, Knaben fallback). Once an episode magnet is picked, the rest of the pipeline (`/api/torrent/start` → `/stream/:hash` → cast) is identical to movies — no separate code path.

EZTV is queried by **numeric IMDb ID** (no `tt`), batched up-front (≤5 pages × 100 results) and cached, so episode + season-pack queries share one fetch. Knaben is invoked when EZTV returns zero matches *and* a series title is available — title is needed because Knaben searches by string.

---

## Architecture

```
Search results
   │ type="series" → MovieCard (TV badge)
   ▼
SeriesDetail.tsx ── GET /api/series/:imdbId ──▶ services/omdb.ts.getSeriesDetails()
   │
   │ Season buttons (1..totalSeasons)
   ▼
   GET /api/series/:imdbId/seasons/:n ──▶ omdb.ts.getSeasonEpisodes()
   │
   │ Episode grid (S##E##)
   ▼
EpisodePicker.tsx
   │ GET /api/search/torrents/episode?imdbId&season&episode&title
   ▼
routes/torrents.ts
   │  ┌── try EZTV (numeric imdbId, batched all pages)
   │  └── if empty AND title set → fall through to Knaben
   ▼
{ episode: TorrentResult[], seasonPacks: TorrentResult[], tried: ["eztv", "knaben"?] }
   │
   │ user picks → POST /api/torrent/start { magnet, title: "Series S01E05 — Ep Title", ... }
   ▼
same pipeline as movies (Phase 2 + 3)
```

## Key files

| Path | Role |
|---|---|
| `apps/server/src/services/eztv.ts` | EZTV adapter — `fetchAllTorrents()` batched + LRU(100, 1h), `searchEpisode()`, `searchSeasonPack()`, `parseQuality()`, `rank()` |
| `apps/server/src/services/omdb.ts` | series detail + per-season episode list (shared with Phase 1) |
| `apps/server/src/services/knaben.ts` | fallback aggregator (Phase 9), called by routes when EZTV is empty |
| `apps/server/src/routes/movies.ts` | `/api/series/:imdbId`, `/api/series/:imdbId/seasons/:season` |
| `apps/server/src/routes/torrents.ts` | `/api/search/torrents/episode` — EZTV → Knaben fallback |
| `apps/server/src/lib/quality.ts` | shared resolution/codec parser, `rankTorrent` (used by EZTV/Knaben) |
| `apps/web/src/components/SeriesDetail.tsx` | series modal — season buttons + episodes grid |
| `apps/web/src/components/EpisodePicker.tsx` | two tabs ("Episode" / "Season pack"); calls `startEpisode()`; shows `tried` sources on empty |
| `apps/web/src/components/MovieCard.tsx` | TV badge for `type === "series"` |
| `packages/shared/src/index.ts` | `ContentType`, `SeriesDetails extends MovieDetails`, `SeriesEpisode`, `TorrentResult.{season,episode}` |
| `apps/server/src/services/__tests__/eztv.test.ts` | parseQuality, toResult, rank, xvid filter |
| `apps/server/src/services/__tests__/knaben.test.ts` | episode-form regex coverage |

## EZTV adapter

- **Endpoint.** `${EZTV_BASE_URL}/api/get-torrents?imdb_id=<numeric>&limit=100&page=N` (default `https://eztvx.to`).
- **Query.** Strips `tt` prefix from the IMDb ID. Batches up to 5 pages (≤500 results), early-stops when a page returns less than `limit`.
- **Response shape.** Array of torrents with `season`, `episode` (numeric or string), `magnet_url`, `filename`/`title`, `seeds`, `peers`, `size_bytes`.
- **Single episode vs season pack.** Season packs identified by `episode = 0` for a given season. Both are passed through the same `rank()` ordering.
- **Quality parsing.** `parseQuality(filename, title)` regex-matches resolution + codec; `xvid` releases are filtered out via `toResult` returning `null`.
- **Ranking.** `castFriendly` (x264 only) → resolution (1080p > 720p > 480p > 2160p) → codec rank → seeds. Note: 2160p deprioritised below 720p because Chromecast Gen 1/2 chokes.
- **Cache.** LRU(100, 1h), keyed by numeric IMDb ID. Episode + season-pack queries share the cached page set.

## OMDb series flow

- `GET /api/series/:imdbId` → `getSeriesDetails()` → `omdbFetch({ i, plot: "full" })`. Includes `totalSeasons`.
- `GET /api/series/:imdbId/seasons/:n` → `getSeasonEpisodes()` → `omdbFetch({ i, Season: n })`. Returns `{ season, episodes: SeriesEpisode[] }`.
- **No bulk fetch.** Seasons are loaded on demand when the user clicks a season button.
- Same shared OMDb LRU cache as movie detail (500 entries, 1h).

## Episode picker UX

1. SeriesDetail modal: poster + metadata + season buttons (1..N).
2. Click season → fetches episode list → 2-column grid showing `S##E## · title · rating · released date`.
3. Click episode → opens EpisodePicker.
4. EpisodePicker has **two tabs**:
   - **Episode** — single-episode releases (best result highlighted).
   - **Season pack** — full-season torrents.
5. Empty state shows the `tried` sources (e.g. "No episode torrents found in eztv, knaben.") plus help text noting older shows have sparse coverage.
6. Click a torrent → `POST /api/torrent/start` with title formatted `${seriesTitle} S${ss}E${ee} — ${episodeTitle}` so history shows it nicely.

## Type handling

| Layer | How movie vs series is distinguished |
|---|---|
| Search | OMDb returns `Type` in `{movie, series, episode}`; `normalizeType()` collapses to `ContentType = "movie" \| "series"` |
| Shared types | `MovieSearchResult.type`, `SeriesDetails extends MovieDetails` with `totalSeasons` |
| Routes | `/api/movies/:imdbId` returns `type: "movie"`, `/api/series/:imdbId` returns `type: "series"` — the route, not the IMDb ID, decides |
| UI | `selected: { imdbId, type }` switches between `MovieDetail` and `SeriesDetail`; `MovieCard` shows "TV" badge |
| Type filter | `App.tsx` passes `typeFilter ∈ {"all", "movie", "series"}` to `/api/search` (Phase 7) |

## Cross-cutting

- Same `/api/torrent/start` and `/stream/:hash` endpoints — no fork in the streaming pipeline.
- `setMeta()` persists episode title and S##E## tag so Library and history show the right label.
- Transcoding (Phase 6) is codec-driven and applies equally to movies and TV.
- The `tried` array surfaces which indexers were consulted for transparency.

## Tests

- `eztv.test.ts` — parseQuality (resolution/codec), toResult (xvid filter, type coercion), rank (castFriendly > resolution > codec > seeds), formatSize.
- `knaben.test.ts` — `episodeMatchesTitle` covers `S01E05`, `s01e05`, `1x05`, `1x5`, `Season 1 Episode 5`, plus boundary checks (`S01E50` vs `S01E05`).
- No tests for OMDb series flow, no end-to-end UI tests.

---

## Gotchas

- **EZTV requires numeric IMDb ID.** Strip the `tt`. Forgetting this returns 0 results silently.
- **Largest-file-wins still applies.** `services/torrent.ts.pickVideoFile()` (Phase 2) picks the largest file in the torrent. For multi-file episode torrents (rare) this is still the right call; for season packs the user may end up casting the wrong episode.
- **Knaben fallback requires the series title.** The route checks for `title` query param before invoking Knaben — without it the fallback is skipped silently.
- **`SeriesEpisode.imdbId` is unused.** OMDb returns it; the UI doesn't link to it. Reserved for future per-episode IMDB navigation.
- **Season 0 (specials) is not handled.** OMDb may return `Season: "0"` for specials; the UI treats it like any other season but EZTV/Knaben rarely tag specials with season 0.
- **Episode title format is hardcoded.** `${seriesTitle} S${ss}E${ee} — ${episodeTitle}`. If someone wants to localize "Episode" as "Ep" or change separator, it's three places.
- **No dedupe across EZTV pages.** If two pages return the same magnet, both end up in the result list.

## Future enhancements

### High priority
- [ ] Manual episode-file picker for season-pack torrents
- [ ] OMDb series detail Vitest coverage (recorded fixtures)
- [ ] Show "season pack" option more prominently when single-episode results are sparse

### Medium priority
- [ ] Per-episode IMDB link using `SeriesEpisode.imdbId`
- [ ] Continue-watching: surface last-played episode of each show on home screen
- [ ] Mark-watched per episode (would require `meta` persistence)

### Low priority
- [ ] Specials (season 0) handling
- [ ] Localize the "S##E##" format
- [ ] Episode plot summaries from a richer source (TVmaze)
