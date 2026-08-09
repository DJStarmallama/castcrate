# Castcrate - Epic Overview

**Epic:** castcrate
**Status:** 🟡 In Progress
**Last Updated:** 2026-08-08 (deploy runbook complete — 2 features complete)

> **This file is the epic marker.** Its presence in `docs/features/castcrate/` tells every Beast Mode command that this folder is an **epic**, not a plain feature. Castcrate is currently organised as a single umbrella epic containing every feature in the project — see Purpose for the rationale (and non-rationale) of that choice.

---

## Purpose

Castcrate is a self-hosted cast/stream box: metadata search → torrent discovery → local playback → Chromecast/DLNA output. All product-facing features live inside this umbrella epic. This grouping is **structural, not thematic** — the features span discovery, playback, casting, library, and platform concerns. Treat the epic as a namespace over the project rather than a coherent product surface. If/when it makes sense, split by theme (`discovery`, `playback`, `casting`, `library`, `platform`) with `/create-epic`.

---

## Features

The full set of features that make up castcrate. Grouped by theme for readability; the epic itself is flat (all 17 live directly under `docs/features/castcrate/`).

| # | Feature | Status | Tasks | Description |
|---|---------|--------|-------|-------------|
| — | **Platform** | | | |
| 1 | scaffold | 🟡 In Progress | 11/19 (58%) | Monorepo scaffold, shared types, dev tooling |
| 2 | dev-ops | 🟡 In Progress | 0/0 | Dev workflow, CI, tooling glue |
| 3 | hardening | 🟢 Complete | 25/25 (100%) | Security & reliability hardening |
| — | **Discovery** | | | |
| 4 | discovery | 🟡 In Progress | 0/0 | Core metadata & search surface |
| 5 | omdb-search | 🟡 In Progress | 9/16 (56%) | OMDB-backed title metadata search |
| 6 | tv-shows | 🟡 In Progress | 13/23 (57%) | TV show / season / episode browsing |
| 7 | library-settings | 🟡 In Progress | 10/22 (45%) | User library preferences & settings |
| — | **Torrent sources** | | | |
| 8 | yts-streaming | 🟡 In Progress | 15/25 (60%) | YTS torrent source integration |
| 9 | knaben-fallback | 🟡 In Progress | 14/25 (56%) | Knaben aggregator as fallback source |
| 10 | torrentday-indexer | 🟡 In Progress | 37/49 (76%) | TorrentDay private-tracker indexer |
| 11 | stremio-addon-source | 🟡 In Progress | 56/73 (77%) | Stremio addons (Torrentio, etc.) as a source |
| — | **Playback** | | | |
| 12 | proxy-routing | 🟡 In Progress | 21/28 (75%) | Streaming proxy & routing layer |
| 13 | transcoding | 🟡 In Progress | 11/22 (50%) | On-the-fly transcoding |
| 14 | subtitles | 🟡 In Progress | 10/20 (50%) | Subtitle sourcing & rendering |
| 15 | player-buffer-ux | 🟡 In Progress | 8/26 (31%) | Buffering overlay & warmup UX. Phase 6 overlay layering shipped (portal fix for Cast + Subtitle dropdowns, unstuck buffer overlay). |
| — | **Casting** | | | |
| 16 | chromecast | 🟡 In Progress | 10/18 (56%) | Chromecast device discovery & session |
| 17 | cast-controls | 🟡 In Progress | 15/25 (60%) | Play/pause/seek/volume for active cast |
| — | **Ops** | | | |
| 18 | media-mac-deploy | 🟢 Complete | 47/47 (100%) | Runbook — deploy CastCrate onto the dedicated 2011 MBP media box (Ubuntu 26.04). ✅ Casting Interstellar to Master Llama end-to-end, retention timer scheduled, auto-start on boot proven. |
| — | **Discovery (planned)** | | | |
| 19 | tmdb-metadata | 🔵 Planned | — | Add TMDB as a metadata provider alongside OMDb (backdrops, better TV data, richer search) — inspired by Jellyfin |

> Reference any feature with `castcrate/<feature-name>` (e.g. `/proceed castcrate/stremio-addon-source`, `/continue-feature castcrate/hardening`). Bare names still resolve via fuzzy fallback (e.g. `/continue-feature discovery` → `castcrate/discovery`). Task counts are pulled from each feature's `tasks.md` and refreshed by `/update-epic`.

---

## Build Order / Dependencies

Most features are already in progress or complete and were built independently before the epic wrapper existed. Ordering is retroactive, based on natural layering:

1. **scaffold / dev-ops / hardening** — platform foundation the rest sits on.
2. **discovery / omdb-search / tv-shows / library-settings** — the "what to watch" surface.
3. **yts-streaming / knaben-fallback / torrentday-indexer / stremio-addon-source** — torrent sources feeding into playback.
4. **proxy-routing / transcoding / subtitles / player-buffer-ux** — the streaming pipeline.
5. **chromecast / cast-controls** — final output to the TV.
6. **media-mac-deploy** — one-off runbook to deploy the epic onto dedicated hardware; runs independent of code progress and can be executed once code is casting cleanly.
7. **tmdb-metadata** — additive metadata provider improvement; can be planned/built any time after the current player-buffer-ux fix pass, no hard dependency on the deploy.

**Dependencies between features:**
- Torrent sources (8–11) all feed into `proxy-routing` (12).
- `player-buffer-ux` (15) depends on the streaming pipeline (12–14) being observable.
- `cast-controls` (17) depends on `chromecast` (16) session state.
- Everything else is loosely coupled and can advance in parallel.

---

## Integration & Architecture

- **Within the epic:** the natural boundaries are the four themes above (discovery / sources / playback / casting) plus the platform layer. Features communicate via the Fastify server (`apps/server/`) exposing HTTP + WS to the React web app (`apps/web/`), sharing types through `@castcrate/shared`.
- **With other epics:** none — this is currently the only epic.
- **Key architectural decisions:** monorepo with pnpm workspaces, Node 22+ ESM, TypeScript strict everywhere, Tailwind v4 on the web, `webtorrent` + `castv2-client` + `bonjour-service` on the server.

---

## Tech Debt / Findings

> Last reviewed: 2026-08-09 by `/review-epic`. Full report synthesized from a whole-epic read (all 19 features + spot-reads of shared/server/web source). Cross-feature items span the named features on both sides; per-feature items attribute a single owner.

**Cross-feature / integration**

- [ ] 🔗 **Indexer fallback wiring duplicated per adapter, error shapes drift** — yts-streaming ↔ knaben-fallback ↔ torrentday-indexer ↔ stremio-addon-source — fallback chain differs for movies vs episodes (`YTS→Stremio→Knaben→TD` vs `EZTV→Stremio→Knaben→TD`); each adapter has its own `searchXxxMovie`/`searchXxxEpisode` naming and its own error shape, forcing `extractTried()` to handle 4+ variants. Extract a `FallbackChain` abstraction in `lib/indexers.ts` so adapters become entries in an array and error normalization happens once.
- [ ] 🔗 **Stremio HTTP-stream sessions bypass history entirely** — stremio-addon-source ↔ library-settings ↔ transcoding — when `result.streamUrl` is set (Real-Debrid), `/api/torrent/start` returns `infoHash: null` and `setMeta()` is skipped; `/api/cast/play`'s `infoHashFromStreamPath()` returns null so history is never appended. Two-tier invisibility (no active-torrent entry AND no history). Decide: allow history with a synthetic id (URL hash) OR surface the tier explicitly in UI. The TODO in `cast.ts` is load-bearing.
- [ ] 🔗 **Stream URL absolute-vs-relative contract is implicit** — yts-streaming ↔ chromecast ↔ stremio-addon-source ↔ transcoding — `routes/cast.ts:69-77` detects absolute Stremio URLs by regex `/^https?:\/\//i` and treats everything else as server-relative. A future indexer returning `cdn.example.com/…` (no scheme) would be mangled silently. Add `StartTorrentResult.streamUrlType?: "absolute" | "relative"` in `@castcrate/shared` and branch on it.
- [ ] 🔗 **Proxy dispatcher cache and provider LRUs coordinate by convention only** — proxy-routing ↔ yts-streaming ↔ knaben-fallback ↔ torrentday-indexer ↔ stremio-addon-source — each provider appends `::proxy:on|off` to its cache key by hand; if one provider is refactored and drops the suffix, proxy toggles silently poison the cache. Export `getCacheKeySuffix()` from `lib/proxy.ts` and have every adapter import it.
- [ ] 🔗 **Error boundary between adapters and `startTorrent()` is asymmetric** — yts-streaming ↔ knaben-fallback ↔ torrentday-indexer ↔ stremio-addon-source ↔ proxy-routing — search failures surface immediately (200 vs 401/502) but post-search failures (`client.add` throwing, EROFS, missing dir) return 200 and only manifest on status polling. Add `StartTorrentResult.error?` and switch to 202 when the pipeline breaks after route return.
- [ ] 🔗 **`@castcrate/shared` doesn't mark read-only vs writable settings** — library-settings ↔ every feature reading `RuntimeSettings` — nothing type-level stops a computed field (e.g. `ffmpegVersion`) from being naïvely wired as PATCH-able. Split into `RuntimeSettingsReadable` (all) and `RuntimeSettingsWritable` (subset); route accepts `Partial<Writable>`.
- [ ] 🔗 **Cast session has no heartbeat — stale sessions live forever** — chromecast ↔ cast-controls ↔ player-buffer-ux — `services/cast.ts` marks sessions stopped only via `player.on("close")`; a powered-off Chromecast never fires it. Player polls at 1s forever. Add a 30s heartbeat that flips status to `disconnected` on failure and emit a WS event (broadcaster is already wired) so the UI can react.
- [ ] 🔗 **Subtitle picker is a no-op during active cast** — subtitles ↔ cast-controls ↔ player-buffer-ux — `SubtitlePicker.tsx` mutates local React state only; nothing reaches the Chromecast. Docs acknowledge it; code doesn't implement either fix. Prefer enumerating tracks upfront + `editTracksInfo` (avoids playback interruption). Blocks cast-completeness. `/review-feature castcrate/subtitles` for the deeper pass.
- [ ] 🔗 **`lib/config.ts::mkdirSync` runs at module-load — bad path = boot failure** — scaffold ↔ yts-streaming ↔ library-settings ↔ transcoding — this is the exact class of bug that caused the tilde-in-env-file incident (`~/home/castcrate/…`) during the deploy. Move `mkdirSync` behind first-use (try/catch with clear error) AND surface path-writability in `/api/system/check`. Fail fast at boot with an actionable message, not a cryptic stack.
- [ ] 🔗 **Torrent-lifecycle idempotency was implicit and untested — the recent crashes proved it** — yts-streaming ↔ library-settings ↔ transcoding ↔ player-buffer-ux — the `4cb84d9` fix (awaiting webtorrent v2's async `remove()` and matching "No torrent with id") closes the immediate hole, but there's still no test for double-delete and no JSDoc contract. Add `services/__tests__/torrent.test.ts` asserting `removeTorrent(hash)` called twice is safe; annotate the DELETE route "Idempotent. Safe to retry."
- [ ] 🔗 **Sensitive settings write with default umask before `6e4f73e`** — proxy-routing ↔ stremio-addon-source ↔ torrentday-indexer — proxy passwords, Real-Debrid keys, and TD creds sit in `~/.castcrate/settings.json`. The `chmod 0o600` fix is in; existing boxes may still have 0o644. Add a boot check that warns/fixes if mode > 0o600 and surface in `/api/system/check`; add a hardening task to audit deployed boxes.
- [ ] 🔗 **Subtitle track has no fallback if torrent disappears mid-cast** — subtitles ↔ chromecast ↔ player-buffer-ux — Chromecast is handed a `/stream/:hash/subtitles/:idx` URL; if the user removes the torrent the receiver silently loses the track. Warn in the picker when casting; ideally pin the underlying file until session ends.
- [ ] 🔗 **Transcoder has no fallback if ffmpeg dies mid-stream** — transcoding ↔ player-buffer-ux ↔ cast-controls — HTTP body just goes silent. Wrap the spawn: if it fails before first byte return 502 so client retries pass-through; log clearly if it dies after. Consider a "transcode failed, retrying pass-through" UX toast.
- [ ] 🔗 **`type` filter is load-bearing in the OMDb cache key but undocumented** — omdb-search ↔ cast-controls ↔ discovery — `services/omdb.ts:54` keys on `JSON.stringify(params)` including `type`; a well-meaning optimization "drop type from the key" would return stale filtered results. Add a comment on both sides, or extract a typed `cacheKey(q, type?)` helper.
- [ ] 🔗 **DNS bypass is a global monkey-patch — no per-indexer opt-out** — knaben-fallback ↔ proxy-routing ↔ (all indexers) — `lib/dns.ts` patches `dns.lookup` process-wide. Users can't want Cloudflare-only for Knaben while trusting ISP DNS for OMDb. Not blocking; document in README and defer per-indexer scoping.
- [ ] 🔗 **Stremio addon URL normalization is heuristic** — stremio-addon-source ↔ discovery ↔ proxy-routing — strip-trailing-`manifest.json`-and-`/` then re-append works today but is brittle against future URL patterns (e.g. `/v2/<config>/manifest.json`). Reject unrecognized shapes at `validateAddon` time; add test fixtures for the known variants.
- [ ] 🔗 **Buffer overlay has no formal state machine — logic scattered across 3+ components** — player-buffer-ux ↔ yts-streaming ↔ transcoding — Phase 6 quick-fix landed without a `BufferState` enum; conditional renders in `Player.tsx`, `BufferingOverlay.tsx`, `CastControls.tsx` all encode transitions independently. Extract `useBufferState()` with an explicit reducer before Phases 2/3 land more state.

**Per-feature tech debt**

- [ ] 💳 **Env vars fragmented, `.env.example` incomplete** — scaffold — `TRANSCODE_BUFFER_PERCENT`, `TRANSCODE_BITRATE`, `FFMPEG_PATH`, `YTS_BASE_URL` are read by code but absent from `.env.example`; `YTS_BASE_URL` bypasses `lib/config.ts` entirely. Land in `hardening` Phase A.
- [ ] 💳 **Hooks and CI not wired** — dev-ops — `build-check.ts` / `skill-reminder` / `edit-tracker` exist as templates but aren't in `settings.local.json`; no GitHub Actions running `pnpm typecheck && pnpm lint` on PR. `/review-feature castcrate/dev-ops`.
- [ ] 💳 **Phases A–D still zero-progress despite epic being in production** — hardening — deploy has landed on real hardware before atomic history writes / ffmpeg cleanup / stream timeouts landed. Bump to front of the queue; `/proceed castcrate/hardening` for Phase A immediately.
- [ ] 💳 **JustWatch + YouTube scrapers have no error recovery** — discovery — undocumented GraphQL + regex-scraped video IDs; both silently return `[]` on breakage. Add defensive parsing with explicit logs, document the query shape in comments, keep the tab non-blocking.
- [ ] 💳 **Zero automated test coverage on OMDb adapter, error mapping is stringly-typed** — omdb-search — no fixtures for 401 / 502 / silent-empty responses; 3-char search floor is a magic constant. Add recorded fixtures + tests; expose OMDb quota in `/api/system/check`. `/review-feature castcrate/omdb-search`.
- [ ] 💳 **Season 0 and lazy-loaded season data both need UX polish** — tv-shows — Season 0 shows as "Season 0" instead of "Specials"; no skeleton while `GET /api/series/:imdb/seasons/:n` runs. Both small fixes; land as a tv-shows follow-up.
- [ ] 💳 **History writes non-atomic; `meta` map can leak; cast-only sessions leave no trace** — library-settings — write is `writeFile()` not temp+rename; nothing clears `meta` on external kill; history only appends on removal, not cast start. Land in `hardening` Phase B.
- [ ] 💳 **`{ sequentialDownload: true }` not explicit; no concurrency cap** — yts-streaming — relies on WebTorrent default; a single user can start N torrents and OOM the 8GB box. Pass the flag explicitly; add `MAX_CONCURRENT_TORRENTS` (default 3).
- [ ] 💳 **Rate-limit handling absent; episode-match regex is fragile; env vars undocumented** — knaben-fallback — no `Retry-After` backoff so batch season searches trip 429s silently; `episodeMatchesTitle()` has 5 hand-rolled patterns; `KNABEN_BASE_URL` / `DNS_BYPASS` / `DNS_UPSTREAMS` absent from `.env.example`.
- [ ] 💳 **Selectors HTML-pinned; no live smoke tests; TV fallback silently skipped without `title`** — torrentday-indexer — single TD redesign breaks the adapter with no signal. Commit anonymized HTML fixtures for regression; log a warning when TV fallback skips due to missing title. `/review-feature castcrate/torrentday-indexer`.
- [ ] 💳 **Addon URLs are bearer tokens stored plaintext (0o600 only); manifest validation loose** — stremio-addon-source — Real-Debrid keys sit on disk; validation checks `manifest.name` but not `resources: ["stream"]` etc. Tighten validation; document the trust model in README; per-addon privacy warning in the UI.
- [ ] 💳 **Dispatcher cache invalidation on settings toggle is convention-only** — proxy-routing — `onSettingsUpdate()` callbacks work but the coupling isn't declared; a refactor of `services/settings.ts` could silently break proxy-toggle correctness. Document invalidation contract in `lib/proxy.ts`; add a `/api/proxy/debug` endpoint returning redacted dispatcher state.
- [ ] 💳 **No auto-transcode probe; ffmpeg subprocesses orphan on SIGKILL; bitrate is global** — transcoding — HEVC files that slip past the indexer filter don't auto-transcode (plan said they would); crashing mid-transcode leaves zombies. Track `subprocesses: Set<ChildProcess>` in `transcoder.ts` and kill them all in the shutdown hook (Phase B of hardening).
- [ ] 💳 **No encoding detection; language guessing is heuristic; subtitles aren't priority-bumped in WebTorrent** — subtitles — non-UTF-8 renders as garbage; picker shows "No subtitles" for minutes while the torrent creeps toward the `.srt`. Add `chardet`+`iconv`; call `file.select(1)` on chosen subtitle to bump priority.
- [ ] 💳 **Overlay layering Phase 6 landed, but Phases 2/3 (buffer-to-N%, dead-swarm CTA) still spec-only** — player-buffer-ux — the deploy surfaced three UX bugs; Phase 6 fixed the immediate blockers but the informal state machine will make Phases 2/3 painful. Extract `useBufferState()` reducer *before* Phases 2/3.
- [ ] 💳 **Single-session model unprotected; no timeout; registered WS unused** — chromecast — two concurrent `POST /api/cast/play` race the Map with last-writer-wins; a device off overnight leaves a session forever; WS plugin is registered but polling is used. Add a heartbeat + a "cast already active" guard; defer WS migration.
- [ ] 💳 **No optimistic UI on seek/volume; keyboard shortcuts missing; type-filter pills vanish under 3 chars** — cast-controls — sliders snap-back on drag; Space/Arrow/M do nothing; changing filter at 2 chars silently clears the filter selection. Optimistic reconcile on next poll; add keyboard listeners; always render the filter pills (disabled when `< 3` chars).
- [ ] 💳 **Movie+series interleave for `type=all` is undocumented behavior** — cast-controls (Phase 7 search-filter) — the interleave order matters for cache-key semantics and UI ordering; an OMDb-adapter optimization could silently break it. Add JSDoc + a test asserting the interleave shape and per-type cache separation.
- [ ] 💳 **Deploy surfaced 6 production bugs — root cause: implicit assumptions about paths, permissions, and error propagation** — media-mac-deploy — every bug fixed, but the *class* of assumption (paths writable, ffmpeg terminates cleanly, remove() is sync, settings writes are atomic) recurs across features. Add a "post-deploy sanity check" section to the runbook AND a startup log line `CastCrate starting on <host> with DOWNLOAD_PATH=<path>` so misconfig is immediately visible.
- [ ] 💳 **Planned, no code yet** — tmdb-metadata — no urgency; sequence after `hardening` Phases B–D and after `player-buffer-ux` Phases 2/3.

**What's already solid**

- ✅ **`@castcrate/shared` contract is strict and enforced end-to-end** — every HTTP/WS payload is a shared type; no `any` at the boundary; new fields propagate automatically to both sides. This is why the source-bug fixes could land as edits, not archaeology.
- ✅ **Indexer adapter shape is uniform and composable** — every source exposes `searchXxx(query) => TorrentResult[]`; new indexers drop into the fallback array with one function.
- ✅ **Server bootstrap order is explicit and testable** — DNS bypass → config → routes → SPA → discovery → shutdown, with the plugin-order gotcha commented; new services have an obvious place to wire shutdown cleanup.
- ✅ **Error surfacing carries the `tried[]` array end-to-end** — the empty-state UI can say "No results from YTS, Knaben, or TorrentDay" instead of a generic failure — one of the more thoughtful pieces of the epic.
- ✅ **Settings ownership is centralized in `services/settings.ts`** — single source of truth, single JSON file, GET-masks-secrets convention; future features extend `RuntimeSettings` rather than sprouting ad-hoc config files.
- ✅ **Monorepo boundaries are clean and build times are reasonable** — `apps/server` / `apps/web` / `packages/shared` cleanly separated, native-build allowlist in place for `webtorrent`, `pnpm build` under a minute.

**Recommended immediate actions (in order)**

1. `/proceed castcrate/hardening` — Phase B (atomic history writes, ffmpeg subprocess cleanup, stream timeouts). Production stability sits on this.
2. Extract `useBufferState()` reducer in `player-buffer-ux` before Phases 2/3 add more transitions.
3. Extract `FallbackChain` abstraction in `lib/indexers.ts` — kills five of the cross-feature findings above at once.
4. Add cast-session heartbeat (`chromecast` + broadcast the event over WS).
5. Implement subtitle hot-swap during active cast (`subtitles` — enumerate tracks upfront + `editTracksInfo`).

---

## Master Overview Rollup

- **Rollup status:** In Progress (2/19 features complete — hardening + **media-mac-deploy 🎯**; ~312/463 tasks ≈ 67%). Deploy landed with a real end-to-end cast on dedicated 2011 MBP hardware; the runbook execution surfaced and fixed a run of production bugs on the way (crash resilience `4cb84d9`, systemd-sandbox hygiene `1d65f44`, player overlay layering `4ca3c2b`, audio loudness chain `254bae8`/`6e4f73e`, SIGTERM shutdown `b48f0b5`).
- **One-line summary for master:** Self-hosted cast/stream box — discovery, torrent sources, playback pipeline, Chromecast output; deployed to dedicated 2011 MBP hardware and casting to a real Chromecast; TMDB metadata pass planned.

---

*This is a required file — do not delete it; it marks the folder as an epic. Update it with `/update-epic castcrate` after working on the epic's features, and run `/review-epic castcrate` to refresh the Tech Debt / Findings section.*
