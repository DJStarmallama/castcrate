# tmdb-metadata — Implementation Plan (skeleton)

**Epic:** castcrate
**Created:** 2026-08-08
**Status:** Skeleton — this is a first-pass architectural sketch, not the full solution-architect output. Run `/plan-feature castcrate/tmdb-metadata` when ready to flesh it out into phases + tasks.

## Approach

Add a **`tmdb` service** alongside the existing `omdb` service on the server. Introduce a small **provider abstraction** so search / lookup can be dispatched to whichever provider(s) the user has enabled, with an optional fallback chain. The web UI stays largely the same; new optional fields (backdrop, trailer, similar titles) render if present, degrade gracefully if absent. This is a **dual-source, non-breaking rollout** — we don't rip out OMDb, we make it one of two options.

## Key Decisions

- **TMDB v3 API, key-in-query authentication.** Simpler than v4 Bearer, no OAuth. The `?api_key=xxx` param is added by the server adapter — the key never leaves the box.
- **Provider abstraction lives on the server**, not shared types. Web sees a unified `SearchResult` type; the provider choice is invisible to the client except in a small `metadataProvider` field for debugging / attribution.
- **Types stay in `@castcrate/shared` and are additive-only.** New optional fields: `backdropUrl?`, `similarTitles?`, `providerId?`, `providerName?`, `trailerUrl?`. Existing consumers don't need to change.
- **IMDb-ID cross-reference via `/find`.** Existing history entries and any OMDb-flavoured deep links (`?imdbId=tt0133093`) continue to resolve — TMDB's `/find/{imdb_id}?external_source=imdb_id` gives us the TMDB ID for free.
- **Provider selection is a `RuntimeSettings` field**, editable in `library-settings`. Default at first-run: `tmdb-then-omdb` fallback if both keys are configured; otherwise whichever key is present. If only OMDb is configured (existing installs pre-this-feature), behaviour is unchanged.
- **No caching layer in v1.** TMDB is CDN-backed and fast; caching adds complexity (stale invalidation, memory pressure) for marginal benefit at single-user LAN scale. Revisit if the free-tier rate limit (40 req / 10 s) ever bites.
- **Search unification: TMDB `/search/multi`** returns movies + TV in one call, matching the current `omdb-search` behaviour. Simpler than dispatching separate `/search/movie` + `/search/tv` calls and merging.
- **TV data source-of-truth switches to TMDB** where it's better (season/episode metadata). OMDb TV endpoints are notoriously incomplete — the `tv-shows` feature will *improve* by depending on TMDB.

## Files affected (rough sketch)

Server:
- **NEW** `apps/server/src/services/tmdb.ts` — TMDB adapter: `search()`, `getMovie()`, `getTv()`, `getSeason()`, `getEpisode()`, `findByImdbId()`.
- **NEW** `apps/server/src/services/metadata.ts` — thin provider dispatcher: reads `settings.metadataProvider`, delegates to `tmdb` / `omdb` / falls back per config.
- **UPDATE** `apps/server/src/routes/omdb.ts` (or wherever the metadata routes live) → change internal implementation to call `metadata.ts` instead of `omdb.ts` directly. Route surface unchanged.
- **UPDATE** `apps/server/src/services/settings.ts` — add `tmdbApiKey`, `metadataProvider: "tmdb" | "omdb" | "tmdb-then-omdb" | "omdb-then-tmdb"`; sanitise + mask on GET.
- **UPDATE** `.env.example` — add `TMDB_API_KEY=` block with sign-up link.

Shared types:
- **UPDATE** `packages/shared/src/index.ts` — extend `SearchResult` (and `MovieDetails`, `TvDetails` if present) with the optional fields listed in Key Decisions.

Web:
- **UPDATE** `apps/web/src/components/Settings.tsx` — new "Metadata provider" section: dropdown for provider choice, key input for TMDB (masked once set), key input for OMDb (existing).
- **UPDATE** search-results rendering — use `backdropUrl` as hero if present, poster fallback otherwise.
- **UPDATE** movie / TV details view — show trailer link if present, similar-titles carousel if present. All optional / progressive-enhancement.
- **UPDATE** the API client shim in `apps/web/src/lib/api.ts` — no signature change; new optional fields carried by the existing types.

Docs:
- **UPDATE** `apps/server/.env.example` (already covered above)
- **UPDATE** README metadata section (if present) with the TMDB / OMDb selector.

## Rough phase sketch (for `/plan-feature` to flesh out)

1. **Types + settings groundwork** — additive shared types, `RuntimeSettings` extension, sanitiser + masked-response for the settings GET.
2. **TMDB adapter** — the `tmdb.ts` service + unit tests against recorded fixtures (search, movie detail, tv+season+episode, imdb-find).
3. **Metadata dispatcher** — `metadata.ts` behind the existing route surface; provider selection logic + fallback; existing OMDb tests continue to pass through it.
4. **Settings UI** — provider picker + TMDB key input in `Settings.tsx`.
5. **Web UI progressive enhancement** — backdrop hero, trailer link, similar titles (only where fields present); no regressions when fields absent.
6. **Docs + `.env.example`** — TMDB sign-up link, provider matrix table.

## Definition of Done (draft — refine in `/plan-feature`)

- With `TMDB_API_KEY` set and provider = `tmdb`, searching returns results with poster + backdrop images, and TV-show searches return correct season/episode counts.
- With provider = `omdb`, behaviour is byte-identical to today (regression test).
- With provider = `tmdb-then-omdb` and TMDB key removed, results still return via OMDb fallback (with a `providerName: "omdb"` marker in the response for debugging).
- IMDb-ID deep links (`?imdbId=tt0133093`) resolve under both providers.
- `pnpm typecheck` clean; `pnpm test` all passing (including new TMDB adapter tests).
- Backdrop hero renders on at least the movie details view when present; poster used as fallback.

## Quality Bar

- **Additive, not disruptive.** Existing OMDb code path stays fully working. Nobody has to migrate; provider swap is a settings toggle.
- **Adapter tests use recorded HTTP fixtures**, not live API calls in CI. TMDB has a public status page — fixtures should be periodically regenerated.
- **API key never in the repo, never in logs.** Follow the same masking pattern as OMDb / TorrentDay creds in the settings GET response.
- **Graceful degradation on TMDB outage.** Adapter should throw typed errors mapped to 502 / 504 at the route boundary; UI shows a "metadata unavailable" state, does not crash the picker.
