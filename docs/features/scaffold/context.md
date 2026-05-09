# scaffold — Context

**Last updated:** 2026-05-09
**Status:** Implemented (retrospective doc)

## Status

- pnpm monorepo + Fastify + Vite + Tailwind v4 + shared types — working
- `pnpm dev` boots both apps; `/api/ping` reachable
- No CI yet; no scaffold-level tests

## Key files

- `apps/server/src/index.ts` — bootstrap, plugin order, static serve, onClose hooks
- `apps/server/src/lib/config.ts` — typed env object, `mkdirSync` for DOWNLOAD_PATH
- `apps/server/src/routes/health.ts` — `/api/ping`, `/api/system/check`
- `apps/web/vite.config.ts` — dev proxies for `/api`, `/stream`, `/ws`
- `apps/web/src/main.tsx` — React Query client (60s staleTime)
- `apps/web/src/index.css` — Tailwind v4 zero-config entrypoint
- `packages/shared/src/index.ts` — sole source of cross-process types
- `tsconfig.base.json` — strict, ES2022, Bundler resolution

## Decisions

- **Fastify over Express.** Native streaming + range support, fast cold start, schema-first routes.
- **OMDb over TMDB.** Keys are easier to obtain; results are simpler; we don't need TMDB's richer metadata.
- **Tailwind v4 zero-config.** No `tailwind.config.js`, no `postcss.config.js`; just `@import "tailwindcss"` in `index.css`. Lower maintenance.
- **JSON file persistence (`~/.castcrate/history.json`) over SQLite.** One user, no concurrency, no schema migrations.
- **`@castcrate/shared` is TS-only.** No build step — imports resolve via tsconfig paths.

## Gotchas

- **Plugin order matters in `index.ts`.** API routes register before the static SPA fallback or every API call returns `index.html`.
- **`0.0.0.0` not `localhost`.** Casting requires LAN-reachable stream URLs; binding to loopback breaks Chromecast.
- **Brand drift.** `LlamaSpitStream` (download path, index.html title) vs `castcrate` (repo, plan). Confusing for new readers.
- **`mkdirSync` on import.** `lib/config.ts` creates `DOWNLOAD_PATH` at module-load time. Move to first-use if it ever causes import failures.
- **`.env.example` is incomplete.** Three transcode vars and `YTS_BASE_URL` are read by code but absent from the template.
