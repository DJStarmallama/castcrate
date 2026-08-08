# tmdb-metadata — Requirements

**Epic:** castcrate
**Created:** 2026-08-08
**Inspired by:** the "borrow from Jellyfin" pass — TMDB is Jellyfin's default metadata source and is objectively richer than OMDb.

## Overview

Replace (or dual-source with) OMDb as CastCrate's metadata provider using **TheMovieDB (TMDB)**. TMDB gives us multiple poster/backdrop images per title, better TV season/episode data, cast/crew, trailers, similar-title recommendations, and a more generous free rate limit — all currently thin or missing with OMDb. The feature scope is limited to metadata (search + lookup); torrent sourcing, casting, and playback are unaffected.

## Requirements

- Add a `tmdb` metadata provider service on the server (`apps/server/src/services/tmdb.ts`) that supports:
  - Free-text title search (movies + TV, unified result shape).
  - Detail lookup by TMDB ID.
  - Optional IMDb-ID → TMDB lookup so existing history entries and OMDb-flavoured URLs still resolve.
  - Multi-image response (poster, backdrop, logo where available).
  - TV: season list + episode list + per-episode metadata.
- Runtime settings expose `TMDB_API_KEY` (server-side `.env`; not committed) and a UI toggle for provider choice: **TMDB only** / **OMDb only** / **TMDB with OMDb fallback**.
- Web UI surfaces new fields where they add value (backdrop as hero, trailer link, similar titles) without breaking any existing search / picker flow.
- Search performance target: p50 latency ≤ 500 ms; p95 ≤ 1.5 s (TMDB is CDN-backed and typically faster than OMDb, so this is a floor, not a stretch).
- Zero regressions to existing consumers: `discovery`, `omdb-search`, `tv-shows`, and `library-settings` features keep working through the same shared types in `@castcrate/shared` (which may gain a small optional-fields extension, not a breaking change).
- No auth beyond the API key (TMDB v3 API is key-in-query or Bearer token).

## Dependencies

- **External:** TMDB v3 API key (register at `https://www.themoviedb.org/settings/api` — free, instant approval). The IMDb-ID lookup uses `/find/{imdb_id}?external_source=imdb_id`, which is part of the free tier.
- **Repo:** touches `apps/server/src/services/`, `apps/server/src/routes/`, `packages/shared/src/index.ts` (types), and `apps/web/src/` (search UI + picker + details view).
- **Existing features to coordinate with:**
  - `omdb-search` — becomes one of two providers; not deleted.
  - `discovery` — unified `SearchResult` shape stays the same; add optional `providerId` / `backdropUrl` / `similar` fields.
  - `tv-shows` — TMDB has real season/episode data (better than OMDb's stubbed responses) — this feature should improve, not break, tv-shows.
  - `library-settings` — gains a "Metadata provider" section.

## Out of Scope

- Full metadata caching / warm-up jobs (TMDB's `changes` endpoint). Keep it stateless in v1; add caching later if the free-tier limits become an issue.
- Multi-language metadata support (English-only in v1; TMDB supports `?language=xx-YY` but not shipping in v1).
- Auto-migrating existing OMDb-based history entries to TMDB IDs. History stays whatever it was; new entries can carry both IDs.
- Rating/review aggregation beyond TMDB's own vote average. No Rotten Tomatoes / Metacritic pass in v1.
- Editorial content (trending, upcoming, popular) — nice to have later but not now.
- Direct image proxying / thumbnailing. Serve TMDB image URLs as-is; browsers cache and CDN handles the load.

---

*Consumed by `/plan-feature castcrate/tmdb-metadata`. See `implementation.md` for the planning notes drafted alongside these requirements; run `/plan-feature` when ready for the full solution-architect pass.*
