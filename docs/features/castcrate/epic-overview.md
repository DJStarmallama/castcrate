# Castcrate - Epic Overview

**Epic:** castcrate
**Status:** 🟡 In Progress
**Last Updated:** 2026-08-06 11:27

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
| 15 | player-buffer-ux | 🟡 In Progress | 3/26 (12%) | Buffering overlay & warmup UX |
| — | **Casting** | | | |
| 16 | chromecast | 🟡 In Progress | 10/18 (56%) | Chromecast device discovery & session |
| 17 | cast-controls | 🟡 In Progress | 15/25 (60%) | Play/pause/seek/volume for active cast |

> Reference any feature with `castcrate/<feature-name>` (e.g. `/proceed castcrate/stremio-addon-source`, `/continue-feature castcrate/hardening`). Bare names still resolve via fuzzy fallback (e.g. `/continue-feature discovery` → `castcrate/discovery`). Task counts are pulled from each feature's `tasks.md` and refreshed by `/update-epic`.

---

## Build Order / Dependencies

Most features are already in progress or complete and were built independently before the epic wrapper existed. Ordering is retroactive, based on natural layering:

1. **scaffold / dev-ops / hardening** — platform foundation the rest sits on.
2. **discovery / omdb-search / tv-shows / library-settings** — the "what to watch" surface.
3. **yts-streaming / knaben-fallback / torrentday-indexer / stremio-addon-source** — torrent sources feeding into playback.
4. **proxy-routing / transcoding / subtitles / player-buffer-ux** — the streaming pipeline.
5. **chromecast / cast-controls** — final output to the TV.

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

Cross-feature tech debt and review findings. **Populated and updated by `/review-epic`**.

- (none yet — run `/review-epic castcrate` to populate)

---

## Master Overview Rollup

- **Rollup status:** In Progress (1/17 features complete — hardening; 260/416 tasks ≈ 63%)
- **One-line summary for master:** Self-hosted cast/stream box — discovery, torrent sources, playback pipeline, and Chromecast output, currently structured as one umbrella epic.

---

*This is a required file — do not delete it; it marks the folder as an epic. Update it with `/update-epic castcrate` after working on the epic's features, and run `/review-epic castcrate` to refresh the Tech Debt / Findings section.*
