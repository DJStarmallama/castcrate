# Castcrate - Epic Requirements

**Created:** 2026-08-06
**Phase:** Ongoing — pre-existing features rolled into an umbrella epic

> Retroactive epic-level scope for the whole castcrate project. Every product feature currently lives here. This file exists so `/plan-epic castcrate` (re-run) and `/update-epic castcrate` have something to consume, and so the shape matches what Beast Mode expects.

## Overview

Castcrate is a self-hosted cast/stream box: metadata search + torrent discovery + local playback + Chromecast/DLNA output. The umbrella epic groups all product features in one namespace; boundaries between them are documented in each feature's own `requirements.md` and `implementation.md`.

## Requirements

- Provide a web UI (`apps/web/`, React 19 + Tailwind v4) for browsing titles and controlling playback.
- Provide a Fastify server (`apps/server/`) that owns torrent streaming, transcoding, subtitles, mDNS discovery, and cast sessions.
- Aggregate multiple torrent sources (YTS, Knaben, TorrentDay, Stremio addons) behind a unified discovery/selection layer.
- Support Chromecast + DLNA output with responsive cast controls and buffer-aware UX.
- Share types across web/server via `@castcrate/shared`; no cross-process type drift.
- Keep security posture explicit — no secrets in code, hardening feature is the reference bar.

## Planned Features

All features are already scaffolded (each has its own `requirements.md` / `implementation.md`). "Build order" is retroactive — see `epic-overview.md` for the layered order.

**Platform**
1. **scaffold** — monorepo, shared types, tooling.
2. **dev-ops** — dev workflow, CI, tooling glue.
3. **hardening** — security & reliability.

**Discovery**
4. **discovery** — core metadata & search surface.
5. **omdb-search** — OMDB metadata provider.
6. **tv-shows** — TV browsing model.
7. **library-settings** — user preferences.

**Torrent sources**
8. **yts-streaming** — YTS source.
9. **knaben-fallback** — Knaben aggregator fallback.
10. **torrentday-indexer** — TorrentDay private tracker indexer.
11. **stremio-addon-source** — Stremio addons (Torrentio).

**Playback**
12. **proxy-routing** — streaming proxy + routing.
13. **transcoding** — on-the-fly transcoding.
14. **subtitles** — subtitle sourcing/rendering.
15. **player-buffer-ux** — buffering overlay + warmup UX.

**Casting**
16. **chromecast** — device discovery & session.
17. **cast-controls** — playback control surface.

## Dependencies

- **External:** OMDB API key, YTS API, Knaben endpoint, TorrentDay session (private tracker), Stremio addons, Chromecast devices on the LAN, `ffmpeg` on host for transcoding.
- **Between features:** all torrent sources depend on the shared discovery selection model; `proxy-routing` is downstream of every source; `chromecast` + `cast-controls` are the terminal consumer.

## Out of Scope

- Splitting castcrate into thematic sub-epics (discovery / playback / casting / …) — not done yet; do it later with `/create-epic` if the umbrella grows unwieldy.
- Any non-Chromecast/DLNA output (AirPlay, native mobile clients).
- Auth / multi-user — this is a single-user self-hosted box.

---

*Consumed by `/plan-epic castcrate`. Per-feature detail lives inside each `docs/features/castcrate/<feature>/requirements.md`.*
