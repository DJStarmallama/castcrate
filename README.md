# CastCrate

Locally-hosted web app: search a movie, find the best torrent, stream it as it downloads, cast it to a Chromecast on your LAN. Single-user, runs on your laptop.

See [`castcrate-requirements.md`](./castcrate-requirements.md) for the full PRD.

## Stack

- **Backend:** Fastify (TypeScript, ESM, Node 20+)
- **Frontend:** Vite + React 19 + Tailwind CSS v4 + TanStack Query
- **Torrent:** WebTorrent (sequential / streaming mode)
- **Cast:** `castv2-client` + mDNS discovery
- **Indexer:** YTS (`yts.mx/api/v2`)
- **Metadata:** TMDB v4

Monorepo with pnpm workspaces (`apps/server`, `apps/web`, `packages/shared`).

## Quickstart

```bash
pnpm install
cp .env.example .env  # then add your TMDB_API_KEY
pnpm dev              # runs server (3000) + web (5173) in parallel
```

Open http://localhost:5173/.

## Scripts

- `pnpm dev` — both apps in parallel
- `pnpm dev:server` / `pnpm dev:web` — one at a time
- `pnpm typecheck` — workspace-wide tsc
- `pnpm build` — production bundles

## Environment

Copy `.env.example` to `.env`. The TMDB key is required for movie search; get one at https://www.themoviedb.org/settings/api (use the v4 Read Access Token).

## Status

In active development. See PRD for phased roadmap.

## Legal

CastCrate is a tool for personal, local use only. Users are solely responsible for ensuring their use of this software complies with applicable copyright laws in their jurisdiction.
