# tv-shows — Tasks

**Last updated:** 2026-05-09
**Progress:** Implemented (retrospective)

## Original implementation (completed)

- [x] EZTV adapter (`services/eztv.ts`) with batched paging + LRU(100, 1h)
- [x] `parseQuality()`, `toResult()` (xvid filter), `rank()` (castFriendly > res > codec > seeds)
- [x] Single-episode vs season-pack distinction (episode=0 → season pack)
- [x] OMDb series detail + per-season episode list
- [x] Routes: `/api/series/:imdbId`, `/api/series/:imdbId/seasons/:n`, `/api/search/torrents/episode`
- [x] EZTV → Knaben fallback wired in route (when EZTV empty + title provided)
- [x] `tried` array surfaced in response
- [x] Web SeriesDetail with season buttons + episodes grid
- [x] Web EpisodePicker with Episode / Season pack tabs
- [x] TV badge on MovieCard
- [x] Type filter at App-level (typeFilter passed to `/api/search`)
- [x] Episode title format: `${series} S##E## — ${episode}`
- [x] Vitest: eztv parser/rank, knaben episode-form regex

## Future enhancements

### High priority
- [ ] Manual episode-file picker for season-pack torrents (replace `pickVideoFile = largest`)
- [ ] OMDb series detail Vitest with recorded fixtures
- [ ] Promote "season pack" tab when single-episode count is low

### Medium priority
- [ ] Continue-watching: surface last-played episode per show
- [ ] Mark-watched per episode (needs persistent state in `meta`)
- [ ] Per-episode IMDB link using `SeriesEpisode.imdbId`

### Low priority
- [ ] Specials (season 0) handling
- [ ] Localized S##E## format
- [ ] Episode overviews from TVmaze
- [ ] Dedupe identical magnets across EZTV pages
