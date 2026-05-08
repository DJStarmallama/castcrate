# CastCrate

Locally-hosted web app: search a movie via TMDB, find a YTS torrent, stream it as it downloads, and cast it to a Chromecast on your LAN — all from a single UI on your laptop.

See [`castcrate-requirements.md`](./castcrate-requirements.md) for the full PRD and [`castcrate-plan.md`](./castcrate-plan.md) for the phased build plan.

## What's built

- **Phase 0** — pnpm monorepo (Fastify server + Vite/React 19/Tailwind v4 web)
- **Phase 1** — TMDB search, debounced title-screen UI, movie detail modal
- **Phase 2** — YTS torrent search (x264 1080p preferred, 720p fallback), WebTorrent streaming, in-browser playback with HTTP byte-range
- **Phase 3** — mDNS Chromecast discovery, `castv2-client` integration, cast/stop/pause/play/seek/volume
- **Phase 4** — Library view (active downloads + history persisted to `~/.castcrate/history.json`), Settings panel, system check

Deferred to v2: x265 / MKV transcoding pipeline (FFmpeg), subtitles, watch history, multi-cast targets.

## Stack

- **Server:** Fastify (TS, ESM) · WebTorrent · castv2-client · bonjour-service · lru-cache
- **Web:** Vite · React 19 · Tailwind v4 · TanStack Query
- **Shared types:** `packages/shared`

## Quickstart

```bash
pnpm install
cp .env.example .env       # then add your TMDB_API_KEY (v4 Read Token)
pnpm dev                   # server :3000  +  web :5173
```

Open http://localhost:5173/.

The first time you run, macOS will prompt to allow incoming connections — required so your Chromecast can reach the stream URL on your LAN.

## Environment

| Var | Default | Notes |
|---|---|---|
| `TMDB_API_KEY` | _empty_ | Required for movie search. Get one at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api). |
| `DOWNLOAD_PATH` | `~/Downloads/CastCrate` | Where torrents are saved |
| `PORT` | `3000` | Server port |
| `BUFFER_PERCENT` | `2` | Pre-cast buffer threshold |
| `YTS_BASE_URL` | `https://yts.mx/api/v2` | Override only if your network blocks `yts.mx` |

## Networking notes

- The server binds to `0.0.0.0:3000` so Chromecasts can fetch the stream — Mac firewall will prompt on first run.
- Many home networks block `yts.mx` at the DNS level. If torrent search fails with a friendly DNS error, switch to a public DNS like `1.1.1.1`, use a VPN, or set `YTS_BASE_URL`.
- Discovery uses `_googlecast._tcp` mDNS; the Mac and Chromecast must be on the same VLAN/Wi-Fi.

## Scripts

| Command | What |
|---|---|
| `pnpm dev` | server + web in parallel |
| `pnpm dev:server` | server only |
| `pnpm dev:web` | web only |
| `pnpm typecheck` | tsc across the workspace |
| `pnpm build` | production bundles |

## Layout

```
apps/
  server/     Fastify + WebTorrent + Cast
  web/        Vite + React UI
packages/
  shared/     API contract types
~/.castcrate/history.json   persisted session history
```

## Legal

CastCrate is a tool for personal, local use only. Users are solely responsible for ensuring their use of this software complies with applicable copyright laws in their jurisdiction.
