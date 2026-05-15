# torrentday-indexer — Tasks

**Last updated:** 2026-05-15
**Progress:** Phases 1-5 complete (server-side); Phase 6 tests passing
**Blocking:** ship `proxy-routing` first (or in parallel) — TD is geoblocked in AUS.

## Phase 0 — Reconnaissance (DONE 2026-05-15)

- [x] Captured search-results page from logged-in session.
- [x] Search fixture saved → `apps/server/src/services/__tests__/fixtures/torrentday-search.html` (4 rows, sanitized).
- [x] Login-redirect fixture stubbed → `fixtures/torrentday-login.html`.
- [x] **Detail-page fixture not needed** — `.torrent` download URL is in the search row (`a.tdm-dl-cell`).
- [x] Selectors pinned in implementation.md.
- [x] Search URL: `/t?q=<query>&<catId>=&<catId>=`. `qf` is search scope, not category filter.
- [x] Category IDs identified: Movies = 96/11/5/48/44/21; TV episodes = 104/32/7/34/26.

## Phase 1 — Settings + types (DONE 2026-05-15)

- [x] Extend `RuntimeSettings` in `services/settings.ts` with `torrentDay: { enabled, uid, pass }`.
- [x] `sanitise()` validates / trims credentials.
- [x] `getSettings()` returns raw values server-side; settings GET endpoint masks `uid`/`pass` to `"***"` on response.
- [x] `TorrentResult.source` extended to `"torrentday"`; add optional `torrentUrl?: string` in `packages/shared/src/index.ts`.

## Phase 2 — Adapter (`services/torrentday.ts`) (DONE 2026-05-15)

- [x] `searchTorrentDayMovie(title, year?)`
- [x] `searchTorrentDayEpisode(title, season, episode)`
- [x] `fetchTorrentBlob(torrentUrl)` → `Buffer`, validates bencode magic byte (single fetch, no detail-page hop)
- [x] `TorrentDayAuthError`, `TorrentDayDisabledError` classes
- [x] LRU cache keyed by `…::${cookieHash}` (sha1 first 8 chars of uid+pass)
- [x] Reuses `getDispatcher("torrentday")` from `lib/proxy.ts`
- [x] Reuses `parseQuality()` from `lib/quality.ts`
- [x] Reuses `episodeMatchesTitle()` from `services/knaben.ts` (imported; not duplicated)

## Phase 3 — Torrent client integration (DONE 2026-05-15)

- [x] `services/torrent.ts` — `startTorrent(input: string | Buffer)` overload; Buffer path via `client.add(buffer, …)`.
- [x] InfoHash dedupe still works for string path; Buffer inputs rely on webtorrent's own duplicate handling.
- [x] Cast / stream-start handler branches: if `result.source === "torrentday"` → `fetchTorrentBlob(result.torrentUrl)` → `startTorrent(buffer)`; else `startTorrent(result.magnet)`. (UI run)

## Phase 4 — Fallback wiring (`routes/torrents.ts`) (DONE 2026-05-15)

- [x] Movie route: append TD after Knaben if `tdAvailable()`.
- [x] Episode route: append TD after Knaben if title present + `tdAvailable()`.
- [x] `tried` array includes `"torrentday"` when invoked.
- [x] Auth errors recorded as `{ source: "torrentday", code: "auth" }` in error array.

## Phase 5 — Test endpoint + UI (server portion DONE 2026-05-15)

- [x] `GET /api/torrentday/test` — runs canned query, returns 1-3 sample titles or error.
- [x] Settings dialog: "Indexers" section with TD toggle + uid/pass inputs (masked) + Test button + cookie-extraction help text. (UI run)
- [x] One-time `<StreamWarning>` toast on first TD-sourced stream (`localStorage` flag). (UI run)

## Phase 6 — Tests (DONE 2026-05-15)

- [x] `torrentday.test.ts` — search HTML → results parsing (5 assertions).
- [x] `torrentday.test.ts` — login-redirect HTML → `TorrentDayAuthError`.
- [x] `torrentday.test.ts` — cookie hash determinism.
- [x] `torrentday.test.ts` — `tdAvailable()` matrix (5 cases).
- [x] `settings.test.ts` — credential round-trip, partial merge, null reset, uid/pass validation (12 tests).
- [ ] Manual smoke checklist:
  - [ ] Configure cookies → `/api/torrentday/test` returns sample titles.
  - [ ] Search a movie absent from YTS / Knaben → TD result appears.
  - [ ] Stream a TD result end-to-end via Cast.
  - [ ] Clear `pass` cookie in settings → next search records auth error.
  - [ ] Toggle off → TD skipped from `tried`.

## Phase 7 — Docs + safety copy (DONE 2026-05-15)

- [x] README — TorrentDay section: how to obtain cookies, AUS users need proxy-routing, ratio responsibility disclaimer.
- [x] Note in README that TD credentials live in `~/.castcrate/settings.json` only (no env, no telemetry).
- [x] In-app warning copy reviewed for tone (informational, not alarmist).

## Future enhancements

### Medium
- [ ] Freeleech-aware ranking (boost freeleech torrents).
- [ ] Generic `PrivateTrackerAdapter` interface — wait for a 2nd private tracker before extracting.
- [ ] Surface user's TD ratio in settings UI.

### Low
- [ ] Auto-detect cookie expiry via background ping; UI nag to refresh.
- [ ] Configurable category list (HD movies, SD TV, anime, etc.).
- [ ] IRC announce bot integration for new-release notifications.
