# CastCrate — Phased Implementation Plan

> Companion to `castcrate-requirements.md` (PRD v0.1.0)
> **Last updated:** 2026-05-08

## Locked decisions (delta from PRD)

| Area | PRD says | v1 decision | Rationale |
|---|---|---|---|
| Backend framework | Express | **Fastify** | Better streaming + native range-request support |
| Torrent source | YTS + torrent-search-api | **YTS only** | Documented, stable, sufficient |
| Quality range | 720p / 1080p / 2160p / x265 | **1080p x264, fallback 720p x264** | No transcoding needed in v1 |
| Transcoding (§6b) | v1 | **Deferred to v2** | Removes FFmpeg dependency |
| Persistence | SQLite | **In-memory + `~/.castcrate/history.json`** | Nothing in v1 needs SQL |
| UI components | hand-rolled | **shadcn/ui** | Faster, consistent |

---

## Repo layout

```
~/Developer/castcrate/
├── apps/
│   ├── web/                  # Vite + React + Tailwind + shadcn
│   └── server/               # Fastify + WebTorrent + castv2-client
├── packages/
│   └── shared/               # Shared TS types (API contracts)
├── .env.example
├── package.json              # pnpm workspaces
├── tsconfig.base.json
├── README.md
└── castcrate-requirements.md
```

Monorepo with **pnpm workspaces**. Single `pnpm dev` runs server (3000) + web (5173).

---

## Phase 0 — Scaffold (½ day)

**Goal:** Empty repo runs, types flow web ↔ server, lint/format wired.

- [ ] `gh repo create castcrate --private` and clone to `~/Developer/castcrate/`
- [ ] pnpm workspace setup (`apps/*`, `packages/*`)
- [ ] `apps/server`: Fastify + TypeScript + tsx watch, health endpoint `/api/ping`
- [ ] `apps/web`: Vite + React + TS + Tailwind + shadcn init
- [ ] `packages/shared`: API contract types (movie, torrent, cast device, session)
- [ ] ESLint + Prettier + `tsc --noEmit` in CI later
- [ ] `.env.example` with `TMDB_API_KEY`, `DOWNLOAD_PATH`, `PORT`, `BUFFER_PERCENT`
- [ ] Root `README.md` with quickstart

**Done when:** `pnpm dev` boots both apps, web fetches `/api/ping` successfully.

---

## Phase 1 — Movie search UI (1 day)

**Goal:** Title-screen search, browse TMDB, pick a movie. No torrenting yet.

- [ ] Server: `GET /api/search/movies?q=` → TMDB `/search/movie` proxy
- [ ] Server: `GET /api/movies/:tmdbId` → TMDB `/movie/{id}` (full details)
- [ ] In-memory LRU cache for TMDB responses (1h TTL)
- [ ] Web: hero/title-screen layout, debounced search input (300ms)
- [ ] Web: result card grid (poster, title, year, rating)
- [ ] Web: movie detail panel (synopsis, runtime, cast, "Find & Cast" CTA — disabled for now)
- [ ] React Query for fetching/caching

**Done when:** Search "Inception" → grid populates → click → detail panel shows.

---

## Phase 2 — YTS search + browser playback (1–2 days)

**Goal:** "Find" flow works end-to-end in the **browser** (no Chromecast yet). Validates streaming pipeline in isolation.

- [ ] Server: YTS client (`/list_movies.json`, `/movie_details.json`)
- [ ] Server: quality filter — `1080p x264` → `720p x264` → none (skip x265/2160p)
- [ ] Server: 1h in-memory cache by `(title, year)`
- [ ] Server: `GET /api/search/torrents?title=&year=` → ranked results
- [ ] Server: WebTorrent engine singleton, sequential mode
- [ ] Server: `POST /api/torrent/start` → `{ infoHash, streamUrl }`
- [ ] Server: `GET /stream/:infoHash` with HTTP range support (Fastify `@fastify/range`)
- [ ] Server: `GET /api/torrent/:infoHash/status` (progress, speed, peers)
- [ ] Web: torrent picker (top result auto-selected, expandable list)
- [ ] Web: `<video>` element bound to `/stream/:infoHash`
- [ ] Web: progress bar via polling (WebSocket can wait for Phase 3)

**Done when:** Click "Find & Cast" → video plays in the browser tab.

---

## Phase 3 — Chromecast discovery + casting (1–2 days)

**Goal:** Send the same stream to a Chromecast on the LAN.

- [ ] Server: mDNS discovery via `bonjour-service` for `_googlecast._tcp`
- [ ] Server: `GET /api/cast/devices` → `[{ id, name, ip, port }]`
- [ ] Server: `castv2-client` integration — Default Media Receiver
- [ ] Server: `POST /api/cast/play` (resolve laptop LAN IP for stream URL)
- [ ] Server: `POST /api/cast/control` (play/pause/stop/seek/volume)
- [ ] Server: cast session state map (in-memory)
- [ ] Server: WebSocket channel `/ws` for progress + cast status push
- [ ] Web: device picker dropdown
- [ ] Web: Now Playing panel — poster, title, transport controls, seek bar, volume
- [ ] Web: respect 2% buffer threshold before launching cast

**Done when:** Cast button → Chromecast plays from laptop, controls work.

---

## Phase 4 — Polish & download management (½–1 day)

- [ ] Settings page: download path, buffer %, max concurrent downloads
- [ ] `~/.castcrate/history.json` — completed sessions
- [ ] Active downloads tab (cancel, delete files)
- [ ] Stop session → prompt to keep or delete torrent data
- [ ] Error states: no Chromecast found, YTS down, no x264 match
- [ ] README: setup, screenshots, legal notice (copy from PRD §10)

**Done when:** Full happy path works cold-start with no manual fiddling.

---

## v2 backlog (post-ship)

Lift directly from PRD §6b and §9:

- MKV / x265 transcoding pipeline (FFmpeg child process, fragmented MP4)
- Subtitles (OpenSubtitles + Cast text tracks)
- SQLite migration for watch history + "continue watching"
- TV show support
- Multiple Cast targets
- Electron wrapper

---

## Open questions before Phase 0

1. **TMDB API key** — do you have one, or should Phase 0 include "register at themoviedb.org"?
2. **GitHub** — private repo confirmed?
3. **Chromecast model** on hand for testing? (Gen 1/2 vs Ultra vs Google TV behave slightly differently re: codec support — affects whether the "x264 only" v1 cut actually plays.)
