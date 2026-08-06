# hardening — Context

**Last updated:** 2026-05-09
**Current phase:** Not started
**Status:** Planned

## Quick status

- 4 ship-able phases (A–D) + 1 deferred phase (E)
- All findings sourced from the Phase 0–9 discovery pass on 2026-05-09
- No dependencies between A/B/C/D — each can ship independently
- Most fixes are <50 LOC; B2 and D5 are larger

## Phase order

Recommend in calendar order, but no hard dep:

1. **A** — docs + one-liners (cheap, removes future confusion)
2. **B** — server hardening (highest correctness payoff)
3. **C** — UX polish (visible to user)
4. **D** — test coverage + CI (locks in B and prevents regressions)

## Key files (touched by this feature)

**Docs / config:**
- `.env.example` (A1)
- `apps/web/index.html`, `apps/server/src/lib/config.ts` (A4)
- `.github/workflows/ci.yml` (D5 — new)

**Server:**
- `apps/server/src/services/torrent.ts` (A3, B4)
- `apps/server/src/services/transcoder.ts` (B2, B5)
- `apps/server/src/services/history.ts` (B1, D4)
- `apps/server/src/routes/cast.ts` (B3)
- `apps/server/src/routes/torrents.ts` (B4, C1)
- `apps/server/src/routes/health.ts` (B5)
- `apps/server/src/index.ts` (B2 — onClose registration)
- `apps/server/src/lib/config.ts` (A2)

**Server tests:**
- `apps/server/src/services/__tests__/omdb.test.ts` (D1 — new)
- `apps/server/src/services/__tests__/knaben.test.ts` (D2 — extend)
- `apps/server/src/services/__tests__/history.test.ts` (D4 — extend)
- `apps/server/src/routes/__tests__/torrents-history.test.ts` (D3 — new)

**Web:**
- `apps/web/src/components/TorrentPicker.tsx` (A5)
- `apps/web/src/components/Library.tsx` (C1)
- `apps/web/src/components/CastControls.tsx` (C2)
- `apps/web/src/components/Player.tsx` (C3, C4)

## Decisions

- **One feature folder, multiple phases.** Bundling avoids 10+ tiny PRs that would each need their own context. Each phase is still individually mergeable.
- **No code change in Phase A.** Docs + one-liners only. Easy to review, easy to revert.
- **Phase D includes CI.** Testing without CI catches regressions inconsistently. Wire them together.
- **Phase E is "documented, not scoped".** Each item is feature-sized; spawn separate workstreams.
- **Each phase has its own acceptance criteria.** Don't merge a phase whose criteria aren't satisfied.

## Gotchas (when implementing)

- **B1 atomic write.** Use `fs.rename` (not `fs.renameSync`) and await it; on Windows `rename` over an existing target throws — use `fs.copyFile` + `unlink` if Windows ever matters.
- **B2 ffmpeg registry.** Track by PID + a `WeakRef` so a finished subprocess GCs cleanly. Unregister on `process.on("exit")` *and* on the request `cleanup()` to avoid double-handling.
- **B3 cast-start history.** Don't double-write when the user later removes the torrent. Either:
  - Update the existing entry on removal (need an id mapping), or
  - Skip the removal-time write if a cast-start entry already exists for this `infoHash`.
  Pick one explicitly in code; both are valid.
- **B4 stream timeout.** Don't time out *every* read — only the first byte. Once the response is flowing, network stalls are the browser's problem.
- **C1 delete-on-disk.** WebTorrent's `client.remove(infoHash, opts, cb)` accepts `{ destroyStore: true }`. Surface this option in `removeTorrent()`.
- **D5 CI.** Use `pnpm/action-setup@v4` and `actions/setup-node@v5` with `cache: pnpm`. The native-build allowlist (`utp-native` etc.) means CI must allow approving builds — `pnpm install --frozen-lockfile` will skip them; that's fine for typecheck/test (only the runtime needs them).

## Why now

The discovery pass surfaced these as repeated themes across phases. Bundling them as one feature:

1. Closes a backlog of small risks before they bite.
2. Establishes test coverage and CI early enough that future features land with a safety net.
3. Removes brand drift and undocumented env vars before any public release.
