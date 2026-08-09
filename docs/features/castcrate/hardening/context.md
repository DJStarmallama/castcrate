# hardening — Context

**Last updated:** 2026-08-09
**Current phase:** Phase B (follow-on) complete
**Status:** ✅ Complete (Phases A–E all shipped; Phase B extended post-hardware-deploy)

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

## Epic Review Findings (2026-08-09)

- 💳 **Phases A–D still zero-progress despite production deploy** — ~~atomic history writes, ffmpeg cleanup, stream timeouts should have landed before real-hardware casting.~~ **Resolved 2026-08-09 in the same session (see Phase B follow-on below):** B2 (ffmpeg exit-await), B4 (stream first-byte timeout on both /stream endpoints), B6 (meta-map cleanup on external torrent close), B7 (removeTorrent idempotency test) landed; B1/B3/B5 verified already implemented.

_Recorded by /review-epic castcrate on 2026-08-09._

## Session log

### 2026-08-09 — Phase B follow-on (post-production-deploy)

Feature was marked complete in Q2, but the epic just shipped to production hardware (Ubuntu 26.04 on a 2011 MBP, casting to a real Chromecast) and the post-deploy bug chain (webtorrent v2 double-remove crash `4cb84d9`, tilde-in-env-file sandbox escape, silent post-ready error swallowing) exposed gaps the original Phase B pass missed. This session extended Phase B with:

**Landed:**
- **B2 rewrite** — `shutdownTranscodes` now awaits each subprocess's `exit` event with a per-process 2s ceiling (previously slept 1.5s regardless). SIGTERM every process first, then SIGKILL any that miss the deadline. Returns once every process is confirmed exited so `index.ts`'s bounded shutdown doesn't race against ffmpeg cleanup.
- **B4 expansion** — first-byte timeout default 30s → 60s, configurable via `STREAM_FIRST_BYTE_TIMEOUT_MS` env, and applied to `/stream/:hash/transcoded` too. Previously only the raw `/stream/:hash` endpoint had the guard — a transcoded stream where ffmpeg never got input bytes would hang the client forever.
- **B6 (new)** — `torrent.once("close", ...)` in `startTorrent` clears the meta map entry when webtorrent destroys the torrent from its own error paths (client.destroy, unrecoverable torrent errors). Previously `meta.delete()` only ran from `removeTorrent()`, so external teardowns leaked the entry for the process lifetime.
- **B7 (new)** — `apps/server/src/services/__tests__/torrent.test.ts` — idempotency contract test with a mocked webtorrent client. Second `removeTorrent()` call swallows "No torrent with id ..." (regression coverage for `4cb84d9`). Also covers meta cleanup, `destroyStore` forwarding, and that unrelated rejections still propagate.

**Test count:** 218 → 222 (+4).
**Typecheck:** clean. **Build:** clean.

**Decisions:**
- Bumped default first-byte timeout 30s → 60s per brief. 30s was chosen originally for aggressive UX but production observed hardware sometimes needs ~40–50s to get first bytes from a fresh torrent with sparse peers. 60s = default value from the brief; env override in place if operator wants tighter.
- `shutdownTranscodes` signature change (`timeoutMs = 1500` → `perProcessTimeoutMs = 2000`) is a non-breaking parameter rename — sole caller in `index.ts` passes no args.
- Chose `torrent.once("close", ...)` over `torrent.on("close", ...)` — the torrent object only emits `close` once (it's destroyed), so a `once` listener is safer against duplicate deletes.

**No surprises:** webtorrent 2.8.5's `torrent.emit('close')` is confirmed by grepping the installed module (`torrent.js` line 1022). Signature added to the local `WtTorrent` interface. Meta cleanup listener is attached inside `client.add()`'s callback, so it applies to every torrent added via `startTorrent()`.

**Not touched (per brief scope):**
- Transcoder fallback logic (separate finding, another agent)
- `packages/shared` types (no new cross-process contract needed)
- Config surface beyond `STREAM_FIRST_BYTE_TIMEOUT_MS`
- Indexer adapters, web files
