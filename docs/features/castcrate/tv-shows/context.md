# tv-shows — Context

**Last updated:** 2026-05-09
**Status:** Implemented (retrospective doc)

## Status

- Search returns movies + series; series open into season → episode → episode-torrent flow
- EZTV primary, Knaben fallback (Phase 9)
- Same start/stream pipeline as movies — no fork
- `eztv.ts` and `knaben.ts` tested at the parser/regex level

## Key files

- `apps/server/src/services/eztv.ts` — adapter, page-batched, LRU(100, 1h)
- `apps/server/src/services/omdb.ts` — series detail + season episodes
- `apps/server/src/services/knaben.ts` — fallback (Phase 9)
- `apps/server/src/routes/torrents.ts` — `/api/search/torrents/episode` (with EZTV→Knaben fallback)
- `apps/server/src/routes/movies.ts` — series + season episodes endpoints
- `apps/web/src/components/SeriesDetail.tsx`, `EpisodePicker.tsx`
- `apps/web/src/components/MovieCard.tsx` — TV badge

## Decisions

- **EZTV by numeric IMDb ID.** Strip `tt`; cleaner index.
- **Batch up to 5 pages, 1h cache.** Episode + season-pack queries share one fetch.
- **Two-tab EpisodePicker.** Single-episode preferred; season pack as opt-in.
- **Title formatting hardcoded.** `${series} S##E## — ${episode}` — same string used across UI and history.
- **`tried` array exposed to UI.** Empty state shows which indexers were consulted.
- **OMDb seasons fetched on click.** Lazy; avoids hitting OMDb for unwatched seasons.

## Gotchas

- **EZTV needs numeric IMDb ID.** Forgetting strips `tt` returns zero silently.
- **Season packs + `pickVideoFile = largest`.** User may cast the wrong episode; no manual file picker.
- **Knaben fallback requires title query param.** Without it, fallback is skipped silently.
- **Specials (season 0) edge case.** Not specifically handled.
- **Same OMDb LRU cache as Phase 1.** Don't refactor cache keys without re-checking series detail behaviour.

## Epic Review Findings (2026-08-09)

- 💳 **Season 0 and lazy-loaded season data need UX polish** — Season 0 shows as "Season 0" instead of "Specials"; no skeleton while `GET /api/series/:imdb/seasons/:n` runs. Small fixes; land as tv-shows follow-up. (See epic-overview.md → Tech Debt / Findings.)

_Recorded by /review-epic castcrate on 2026-08-09._
