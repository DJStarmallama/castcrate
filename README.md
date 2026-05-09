# Llama Spit Stream

Locally-hosted web app: search a movie or TV show, find a torrent, stream it as it downloads, and cast it to a Chromecast on your LAN — all from a single UI on your laptop.

See [`castcrate-requirements.md`](./castcrate-requirements.md) for the original PRD (under the previous CastCrate codename) and [`castcrate-plan.md`](./castcrate-plan.md) for the phased build plan.

## What's built

- **Phase 0** — pnpm monorepo (Fastify server + Vite/React 19/Tailwind v4 web)
- **Phase 1** — OMDb search, debounced title-screen UI, movie detail modal
- **Phase 2** — YTS torrent search (x264 1080p preferred, 720p fallback), WebTorrent streaming, in-browser playback with HTTP byte-range
- **Phase 3** — mDNS Chromecast discovery, `castv2-client` integration, cast/stop/pause/play/seek/volume
- **Phase 4** — Library view (active downloads + history persisted to `~/.castcrate/history.json`), Settings panel, system check
- **Phase 5** — TV shows: OMDb series detail with season/episode picker; EZTV adapter for episode + season-pack torrents; "TV" badge in search results
- **Phase 6** — Real-time transcode (FFmpeg → fragmented MP4 capped at 5 Mbps) for smooth 1080p casting and HEVC playback on older Chromecasts; toggle in Settings

Deferred: subtitles, watch history with resume, multi-cast targets, seek-during-transcode.

## Stack

- **Server:** Fastify (TS, ESM) · WebTorrent · castv2-client · bonjour-service · lru-cache
- **Web:** Vite · React 19 · Tailwind v4 · TanStack Query
- **Shared types:** `packages/shared`

## Quickstart

```bash
pnpm install
cp .env.example .env       # then add your OMDB_API_KEY (free key from omdbapi.com)
pnpm dev                   # server :3000  +  web :5173
```

Open http://localhost:5173/.

The first time you run, macOS will prompt to allow incoming connections — required so your Chromecast can reach the stream URL on your LAN.

## Environment

| Var | Default | Notes |
|---|---|---|
| `OMDB_API_KEY` | _empty_ | Required for movie search. Free key at [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx) — you'll get an email with both the key and an activation link; click the link before using the key. |
| `DOWNLOAD_PATH` | `~/Downloads/CastCrate` | Where torrents are saved |
| `PORT` | `3000` | Server port |
| `BUFFER_PERCENT` | `2` | Pre-cast buffer threshold |
| `YTS_BASE_URL` | `https://movies-api.accel.li/api/v2` | YTS rotates domains when seized; override if the default stops responding |

## Networking notes

- The server binds to `0.0.0.0:3000` so Chromecasts can fetch the stream — Mac firewall will prompt on first run.
- YTS rotates domains when one gets seized. The default `YTS_BASE_URL` is the current canonical API host as of 2026-05. If torrent search starts failing with a network error, find an active mirror and override `YTS_BASE_URL` in `.env`.
- Discovery uses `_googlecast._tcp` mDNS; the Mac and Chromecast must be on the same VLAN/Wi-Fi.

### VPN setup (recommended)

Many home networks block torrent indexers at the DNS level, and ISPs can log torrent traffic. A VPN solves both at once. Mullvad is the recommended pick (€5/month flat, anonymous account, WireGuard).

**Critical when running this app:** in the Mullvad client, enable **Settings → VPN settings → Local network sharing**. Without it, the laptop can't reach Chromecasts on the LAN (192.168.x.x) and casting breaks. Same setting exists in most VPN clients under names like "split tunneling" or "allow LAN".

After connecting, restart `pnpm dev` so Node picks up the new network state.

## Scripts

| Command | What |
|---|---|
| `pnpm dev` | server (3000) + Vite (5173) in parallel — for active development |
| `pnpm dev:server` | server only |
| `pnpm dev:web` | web only |
| `pnpm typecheck` | tsc across the workspace |
| `pnpm test` | vitest |
| `pnpm build` | production bundles for both apps |
| `pnpm start` | runs the server in prod mode — serves the built web bundle from the same process on port 3000 |

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
