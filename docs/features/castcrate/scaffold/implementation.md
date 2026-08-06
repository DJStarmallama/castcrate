# Feature: scaffold — Phase 0 (Retrospective)

**Status:** Implemented
**Documented:** 2026-05-09
**Phase:** 0 — first commit, foundational

## Executive summary

The scaffold sets up the pnpm monorepo, the Fastify server (Node 22+ ESM with `tsx watch`), the Vite + React 19 + Tailwind v4 web app, and the cross-process types package. The server binds `0.0.0.0:3000` (LAN-reachable for Chromecast), exposes a `/api/ping` health route, and serves the built web bundle in production with an SPA 404→`index.html` fallback. TypeScript is strict end-to-end; cross-process API types live in `@castcrate/shared`.

This was originally drafted with TMDB + Express in `castcrate-plan.md`; landed as **OMDb + Fastify + Tailwind v4** (no `tailwind.config.js`).

---

## Layout

```
castcrate/
├── apps/
│   ├── server/   Fastify, owns routing/torrenting/casting/transcoding
│   └── web/      Vite + React + Tailwind v4
├── packages/shared/   API contract types
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
└── .env.example
```

## Key files

| Path | Role |
|---|---|
| `package.json`, `pnpm-workspace.yaml` | workspace + native-build allowlist (`bufferutil`, `esbuild`, `node-datachannel`, `protobufjs`, `utf-8-validate`, `utp-native`) |
| `tsconfig.base.json` | ES2022, `moduleResolution: "Bundler"`, strict |
| `apps/server/src/index.ts` | Fastify bootstrap — loads `.env`, registers route plugins, registers `@fastify/websocket` for `/ws`, serves `apps/web/dist`, wires `onClose` shutdown hooks for discovery/cast/torrent |
| `apps/server/src/lib/config.ts` | Single typed config object — see env table below |
| `apps/server/src/routes/health.ts` | `GET /api/ping`, `GET /api/system/check` (config + ffmpeg state) |
| `apps/web/vite.config.ts` | Proxies `/api`, `/stream`, `/ws` to `127.0.0.1:3000` (dev) |
| `apps/web/src/main.tsx` | TanStack Query client (`staleTime: 60000`, `refetchOnWindowFocus: false`) |
| `apps/web/src/index.css` | Tailwind v4 entrypoint (`@import "tailwindcss"`, no config file) |
| `apps/web/index.html` | brand title — `Llama Spit Stream` |
| `packages/shared/src/index.ts` | `MovieSearchResult`, `MovieDetails`, `SeriesDetails`, `SeriesEpisode`, `TorrentResult`, `CastDevice`, `TorrentStatus`, `CastSession`, `CastSessionStatus` |

## Environment

Loaded via `dotenv` early in `apps/server/src/index.ts`, then exposed as a typed object from `lib/config.ts`.

| Var | Required | Default | Notes |
|---|---|---|---|
| `OMDB_API_KEY` | yes | `""` | empty default; omdb.ts surfaces 401/503 |
| `PORT` | no | `3000` | server bind port |
| `DOWNLOAD_PATH` | no | `~/Downloads/LlamaSpitStream` | created at module-load (`mkdirSync recursive`) |
| `BUFFER_PERCENT` | no | `2` | pre-cast threshold |
| `TRANSCODE_BUFFER_PERCENT` | no | `5` | undocumented in `.env.example` |
| `TRANSCODE_BITRATE` | no | `5M` | undocumented in `.env.example` |
| `FFMPEG_PATH` | no | `ffmpeg` | undocumented in `.env.example` |
| `YTS_BASE_URL` | no | (in yts.ts) | not in config.ts; read directly |

## Bootstrap order

1. `dotenv` — load `.env` from project root, then from `apps/server/`.
2. `setupDnsBypass()` (Phase 9) — monkey-patch `dns.lookup` for ISP-block circumvention.
3. Register Fastify plugins (CORS if any, `@fastify/websocket`).
4. Register route plugins: health, movies, torrents, cast, history, subtitles.
5. Static-serve `apps/web/dist` with SPA fallback (404 not `/api`/`/stream` → `index.html`).
6. Register `onClose` shutdown handlers (mDNS browser, cast sessions, WebTorrent client).
7. Listen on `0.0.0.0:${PORT}`.

The order matters: API routes are registered **before** static-serve so they take precedence over the SPA fallback.

## Cross-process contract

`@castcrate/shared` is a TypeScript-only package (no build step) imported by both apps. Every HTTP/WS payload flowing between server and web should reference a type from this package — no `any` on the boundary.

## Tests

No tests for the scaffold itself (config loading, health route, bootstrap order). Indexer adapters and pure helpers (range, srt, history) are tested.

---

## Gotchas

- **Brand drift.** `castcrate-plan.md` says CastCrate; `index.html` says Llama Spit Stream; `DOWNLOAD_PATH` default is `~/Downloads/LlamaSpitStream`. Pick one and align before public release.
- **`.env.example` is incomplete.** It documents `OMDB_API_KEY`, `DOWNLOAD_PATH`, `PORT`, `BUFFER_PERCENT` only. Three transcode-related vars and `YTS_BASE_URL` are read but undocumented.
- **`mkdirSync` at module load.** `lib/config.ts` creates `DOWNLOAD_PATH` synchronously when imported. If the parent directory is unwritable, the server crashes at import time, not at first download.
- **Server must bind `0.0.0.0`, not `localhost`.** Chromecasts on the LAN need to reach the laptop's stream URL by LAN IP. macOS will prompt for incoming-connection permission on first run.

## Future enhancements

- [ ] Document the missing env vars in `.env.example`.
- [ ] Pick a single brand name across `index.html`, `DOWNLOAD_PATH` default, README.
- [ ] Defer `mkdirSync` until first torrent start (fail at use-time, not import-time).
- [ ] Add a Vitest smoke test for health route registration order.
- [ ] CI: `pnpm typecheck`, `pnpm lint`, `pnpm test` on PR.
