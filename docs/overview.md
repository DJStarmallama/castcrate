# CastCrate - Master Overview

**Last Updated:** 2026-08-07
**Version:** v1.1

## Project Summary

CastCrate is a locally-hosted, single-user web app that turns "I want to watch this movie" into a Chromecast playback session in under a minute — search → torrent → stream-as-you-download → cast — with zero cloud, zero accounts, zero subscriptions. Everything runs on the user's laptop; the server binds `0.0.0.0:3000` only so LAN Chromecasts can reach the stream URL. Chromecast is a first-class target: the transcode pipeline (FFmpeg → fragmented MP4, ≤5 Mbps) exists to make casting reliable on real hardware.

## Feature Status

All product features currently live inside the **castcrate** umbrella epic (`docs/features/castcrate/`). See `docs/features/castcrate/epic-overview.md` for the per-feature breakdown.

| Feature | Status | Tasks | Notes |
|---------|--------|-------|-------|
| **castcrate** (epic, 18 features) | 🟡 In Progress | 260/463 (56%) | Self-hosted cast/stream box — discovery, torrent sources, playback pipeline, Chromecast output, plus dedicated-hardware deploy runbook; 1 feature complete (hardening), 15 in progress, 2 requirements-only (discovery, dev-ops). |

## Integration Points

- **Server ↔ Web:** Fastify server (`apps/server/`) exposes HTTP + WS to the React 19 + Tailwind v4 web app (`apps/web/`); types shared through `@castcrate/shared` (no cross-process drift).
- **Discovery → Sources → Playback:** discovery/omdb-search resolve titles; torrent sources (yts-streaming, knaben-fallback, torrentday-indexer, stremio-addon-source) return magnets; proxy-routing streams them through transcoding/subtitles; player-buffer-ux surfaces warmup state.
- **Playback → Cast:** chromecast owns mDNS discovery + `castv2-client` sessions; cast-controls provides play/pause/seek/volume on the active session.
- **Cross-cutting:** hardening sets the security bar for the whole surface; scaffold + dev-ops own the monorepo/tooling everything else depends on.

## Changelog

- v1.1 (2026-08-07): **Added `media-mac-deploy` runbook feature** — 7-phase, 47-task runbook to deploy CastCrate onto a dedicated Early-2011 MacBook Pro 13" running Ubuntu Server 26.04. Epic now 18 features (260/463 tasks, 56%).
- v1.0 (2026-08-06): **Initial master overview** — Created with a single `castcrate` epic row after rolling all 17 pre-existing features under `docs/features/castcrate/`. Rollup: 260/416 tasks (63%), 1 feature complete (hardening).
