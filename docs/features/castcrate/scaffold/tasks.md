# scaffold — Tasks

**Last updated:** 2026-05-09
**Progress:** Implemented (retrospective)

## Original implementation (completed)

- [x] pnpm workspace (`apps/*`, `packages/*`) with native-build allowlist
- [x] `apps/server` — Fastify, `tsx watch`, ESM, Node 22+
- [x] `apps/web` — Vite + React 19 + Tailwind v4
- [x] `packages/shared` — cross-process types (movie, series, torrent, cast)
- [x] `tsconfig.base.json` — strict, ES2022, Bundler resolution
- [x] `apps/server/src/lib/config.ts` — typed env object, dotenv from root + `apps/server/`
- [x] `apps/server/src/routes/health.ts` — `/api/ping`, `/api/system/check`
- [x] Vite dev proxies for `/api`, `/stream`, `/ws`
- [x] TanStack Query client (60s staleTime)
- [x] SPA fallback for non-API/stream 404s
- [x] `onClose` hooks for discovery, cast, torrent shutdown

## Future enhancements

### High priority
- [ ] Document `TRANSCODE_BUFFER_PERCENT`, `TRANSCODE_BITRATE`, `FFMPEG_PATH`, `YTS_BASE_URL` in `.env.example`
- [ ] Resolve brand drift (`Llama Spit Stream` vs `CastCrate`) in `index.html` title and `DOWNLOAD_PATH` default
- [ ] CI workflow: `pnpm typecheck`, `pnpm lint`, `pnpm test` on PR

### Medium priority
- [ ] Defer `mkdirSync(DOWNLOAD_PATH)` from module-load to first-use
- [ ] Vitest smoke test for route registration order (API before SPA fallback)
- [ ] README quickstart screenshots

### Low priority
- [ ] Move `YTS_BASE_URL` into `lib/config.ts` for consistency with other env vars
- [ ] Tighten `apps/web/tsconfig.json` to match base strictness
