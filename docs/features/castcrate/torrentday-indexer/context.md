# torrentday-indexer — Context

**Last updated:** 2026-08-09
**Status:** All phases complete — server + UI shipped; manual smoke tests pending
**Depends on:** `proxy-routing` (recommended; geoblocked in AUS)

## 2026-08-09 — IndexerAdapter registration

- `services/torrentday.ts` now exports `torrentdayAdapter: IndexerAdapter` (`supportsMovie`, `supportsEpisode`; no season packs) at the bottom of the file.
- `routes/torrents.ts` places it last in `movieChain` and `episodeChain`; the inline `if (results.length === 0 && tdAvailable()) { ... TorrentDayAuthError branch ... }` blocks are gone.
- `enabled()` returns `tdAvailable() && (kind === 'movie' || query.title)` — preserves the old route's `title && tdAvailable()` gate for episodes so TD only runs when there's a series title to search.
- `formatThrown()` maps `TorrentDayAuthError → { source: "torrentday", code: "auth" }` and other throws to `{ code: "fetch" }`, preserving the structured wire error shape the old route produced.
- `searchTorrentDayMovie/Episode()`, `fetchTorrentBlob()`, `tdAvailable()`, error classes: all unchanged and still exported for use by `routes/torrentday.ts` (test endpoint) and `/api/torrent/start`.

## Problem

YTS / EZTV / Knaben coverage misses a lot of mid-popularity TV and obscure-format movie releases. TorrentDay (TD) is a private tracker with deeper catalogue and well-seeded older releases. Adding it gives a meaningful long-tail coverage boost — especially for TV episodes where EZTV gaps and Knaben's free-text matching gets noisy.

## Goal

Add TD as an opt-in indexer behind user-supplied credentials, surfaced through the same `TorrentResult` contract as existing providers, with the same fallback semantics: another link in the chain, not a replacement.

## Non-goals

- Bypassing TD's ratio enforcement / inflating user upload (we don't seed beyond what webtorrent does naturally).
- Bundling or distributing TD credentials.
- Working around invite-only signup. Users bring their own account.
- Making TD the primary indexer — it stays behind YTS/EZTV/Knaben in the fallback order.
- Supporting other private trackers in this feature (IPTorrents, BroadcasTheNet, etc.) — separate features if desired, but the patterns established here should generalise.

## Scope

In:
- `services/torrentday.ts` adapter — search by title (movies) + by title+S/E (TV episodes).
- Credential storage in runtime settings (`torrentDayCookie` or `torrentDayPasskey`, depending on auth path chosen).
- `.torrent` blob fetch (TD magnets carry user-bound announce URLs, but most reliable path is the `.torrent` file).
- Extend `startTorrent()` in `services/torrent.ts` to accept either a magnet string or a `.torrent` `Buffer`.
- Wire TD into the fallback chain in `routes/torrents.ts` — order: YTS → Knaben → TD (movies); EZTV → Knaben → TD (TV).
- Per-feature toggle (default off). Hard-disabled if no credentials configured.
- Use the `proxy-routing` dispatcher when `proxyEnabled.torrentday === true`.

Out:
- TD's `seedbonus` API, profile stats, IRC announce listening.
- Custom tracker URL hosting / re-announce on our side.
- Streaming-optimised piece selection beyond what webtorrent already does.

## Decisions

- **Cookie auth, not scraping login.** User pastes their `uid` + `pass` cookie values from a logged-in browser session. Avoids storing the password and avoids handling 2FA / captcha on login. Cookies are long-lived on TD.
- **Fetch `.torrent` files, not magnets.** TD's announce URL is per-user (passkey-bearing). Magnets without that announce won't find peers reliably. The `.torrent` file embeds the correct announce.
- **Pass `.torrent` buffer to webtorrent.** `client.add()` accepts a Buffer directly — no temp files.
- **Last in fallback chain.** TD is private; minimise hits to preserve account standing. Only invoke when public indexers return empty.
- **Default off + hard-gate on credentials.** `proxyEnabled.torrentday` toggle is independent from credential presence; both must be set or TD is skipped silently with a log line.
- **Use proxy-routing when blocked.** TD is geoblocked in AUS; this feature ships with `proxyEnabled.torrentday` defaulting to `false` but documented as required for AUS users.
- **Surface a ratio warning in UI.** First time a TD result is selected for streaming, show a one-time toast: "Streaming via private tracker — your upload may not match download. Check your ratio policy."

## Gotchas

- **Credential leak risk.** Cookies are bearer-equivalent. Never log them; redact in any error path. Don't return them from any API endpoint.
- **Account ban risk.** TD's ToS may forbid third-party clients. Document that cratebuddy is unofficial and that account standing is the user's responsibility.
- **HTML scraping fragility.** TD's search is HTML, no documented public JSON API. Selectors will break when they redesign. Pin a parser that's narrow (find the result table, iterate rows) and unit-test against captured fixtures.
- **Rate limits.** TD throttles aggressive scraping. LRU cache is mandatory; no parallel fan-out across queries.
- **`uid` / `pass` cookie rotation.** TD rotates session cookies on logout. If the user logs out elsewhere, our stored cookie dies — surface an auth-failed error clearly so they know to refresh.
- **`startTorrent` API change ripples.** Anywhere that calls `startTorrent(magnet)` needs to keep working; the change should be additive (overload accepting `Buffer | string`).
- **Cache by query + cookie hash.** If users share a `~/.castcrate` between accounts (rare but possible), don't serve one user's cached TD results to another. Hash the cookie into the cache key.
- **No CSRF / referer gotchas yet known.** If TD adds these, the adapter will need to fetch the search page first to harvest tokens.
