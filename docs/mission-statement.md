# CastCrate

## Mission Statement

**A locally-hosted, single-user web app that turns "I want to watch this movie" into a Chromecast playback session in under a minute — search → torrent → stream-as-you-download → cast — with zero cloud, zero accounts, zero subscriptions.**

CastCrate exists because the current alternatives all compromise: streaming services fragment libraries across a dozen subscriptions, traditional torrenting forces you to wait for full downloads and copy files around manually, and self-hosted media servers (Plex, Jellyfin) demand you curate a library before you can watch anything. CastCrate collapses the whole flow into one UI on the user's laptop and starts playing within seconds of clicking a result.

---

## Core Philosophy

### Local-only, no accounts, no telemetry

Everything runs on the user's laptop. No cloud, no auth, no analytics, no remote control plane. The server binds to `0.0.0.0:3000` only because Chromecasts on the LAN need to reach the stream URL — there is no remote access mode and no plan to add one.

### Watching now beats curating a library

CastCrate is not a media library. There is no "add to collection" or metadata curation step. The user types a title, picks an episode, and casts. History is persisted to `~/.castcrate/history.json` purely as a recents list, not a library to manage.

### Chromecast is a first-class target, not an afterthought

The whole architecture is shaped by Chromecast's quirks: stream URLs must be reachable on the LAN; older Chromecasts can't decode HEVC; codecs that browsers play happily often won't cast. The transcode pipeline (FFmpeg → fragmented MP4 capped at 5 Mbps) exists to make casting reliable on real hardware, not to chase quality benchmarks.

---

## What We're Building

### High-level pipeline

1. User searches a movie or TV title in the web UI (port `5173` in dev, served from `:3000` in prod).
2. Server hits OMDb for metadata; for TV, the user picks season + episode.
3. Torrent indexer (YTS for movies, EZTV for TV, Knaben as fallback) returns the best-match magnet — quality preference: x264 1080p → 720p.
4. WebTorrent starts a sequential download to `~/Downloads/CastCrate`.
5. Server exposes the in-progress file as an HTTP byte-range stream — optionally piped through FFmpeg for real-time transcode when the source codec/bitrate would break Chromecast playback.
6. mDNS discovers Chromecasts on the LAN; `castv2-client` initiates the session and exposes play/pause/seek/volume to the UI.

### Key differentiator

There's no "download then watch" — the stream URL is live the moment WebTorrent has the first piece. Casting starts as soon as the pre-cast buffer threshold is met (`BUFFER_PERCENT`, default 2%), not when the download finishes.

---

## Who This Is For

### The primary user: a single technically-comfortable person on their laptop

They have a Chromecast on the same LAN, are fine running `pnpm dev` or `pnpm start`, will set up a VPN themselves, and accept that this is a tool for personal use only. They already know what they want to watch — they don't need recommendations, libraries, or social features.

### The legal context

Per the README: users are solely responsible for ensuring their use of this software complies with applicable copyright laws in their jurisdiction. The project is a tool, not a service; it ships no content.

---

## What CastCrate Is Not

- **Not a media server.** No multi-user accounts, no remote access, no library management, no transcoding-on-storage. Plex/Jellyfin solve that problem; CastCrate doesn't.
- **Not a streaming service replacement for "browse and discover" use cases.** Search is keyword-driven; there is no recommendation engine, no homepage carousel, no editorialised collections.
- **Not cross-network.** It assumes a single LAN with the laptop and Chromecast on the same Wi-Fi/VLAN. mDNS discovery and the stream URL both depend on this.
- **Not a torrent power-user UI.** No tracker management, no per-torrent settings, no labelling. The torrent layer is invisible — picking a torrent is an implementation detail of "play this title".
- **Not subtitle-aware (Phase 8+).** Side-loaded SRT/VTT was added in Phase 8; subtitle search/auto-fetch is deferred.

---

## Design Pillars

1. **Single-user, single-LAN, single-laptop.** Every architectural choice — bind address, no auth, mDNS discovery, history file in `~/.castcrate/` — assumes this scope. Don't add features that break it.

2. **Time-to-first-frame is the headline metric.** Sequential WebTorrent download, low pre-cast buffer threshold, transcode-on-the-fly — all aimed at minimising the gap between "click play" and "frames on the TV".

3. **Indexer churn is a fact of life.** YTS, EZTV, and Knaben rotate domains when seized. Indexer URLs are env-overridable (`YTS_BASE_URL`) and adapters are kept thin so swapping/adding a fallback is cheap.

4. **Chromecast compatibility wins over fidelity.** When a source won't cast cleanly, transcode it down. A reliably-playing 5 Mbps H.264 stream beats a stalling 25 Mbps HEVC source every time.

5. **The torrent layer is a means, not the product.** Anything torrent-specific (peer counts, ratios, seeders) is hidden from the UI unless it directly affects playability.

---

## Technical Direction

### Local-process monolith, not microservices

One Fastify process owns search, torrenting, transcoding, mDNS discovery, casting, and serving the web bundle. There is no message queue, no separate worker, no separate db process. State lives in memory or in a single JSON file at `~/.castcrate/history.json`.

### TypeScript end-to-end with shared contracts

Both apps are TypeScript strict; cross-process types live in `@castcrate/shared` and are imported by both server and web. There is no codegen and no separate API schema language.

### Quality is verified at the seam, not just unit-tested

Casting, transcoding, and mDNS discovery have failure modes that mocks miss (firewalls, codec quirks, Mullvad's local-network-sharing toggle). The README explicitly documents these real-world gotchas; tests should follow suit and exercise the real network paths where practical.

---

*This document is a living guide. It will evolve as the project develops, but the core mission — local-only, watch-now, Chromecast-first — does not change.*
