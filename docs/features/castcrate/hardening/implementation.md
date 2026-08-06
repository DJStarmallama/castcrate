# Feature: hardening — cross-cutting fixes

**Status:** Planned
**Created:** 2026-05-09
**Source:** Discovery pass over Phases 0–9 (see `docs/features/<phase>/implementation.md` for context)

## Executive summary

A bundle of small, high-leverage fixes spanning multiple existing phases. None of these belong to a single feature — they're issues the discovery pass surfaced repeatedly: missing env-var documentation, an implicit-but-not-asserted WebTorrent flag, ffmpeg subprocess orphans on shutdown, a history file that can corrupt on crash, brand drift, and missing test coverage. Fixed together because they share editing surface (`config.ts`, `index.ts`, `services/torrent.ts`, `services/transcoder.ts`, `services/history.ts`, `.env.example`) and are too small individually to warrant their own feature.

Phases are scoped so each delivers a working app — none requires the next to be useful.

---

## Phases

### Phase A — Docs & one-line correctness (½ day)

Pure documentation + trivial code fixes. No behavioural change.

- **A1.** Update `.env.example` to document every var the server reads:
  - `TRANSCODE_BUFFER_PERCENT`, `TRANSCODE_BITRATE`, `FFMPEG_PATH` (transcoding)
  - `YTS_BASE_URL` (currently read in `services/yts.ts`, not in `lib/config.ts`)
  - `KNABEN_BASE_URL`, `DNS_BYPASS`, `DNS_UPSTREAMS` (Phase 9)
- **A2.** Move `YTS_BASE_URL` into `lib/config.ts` for consistency with other env vars.
- **A3.** Pass `{ sequentialDownload: true }` explicitly to `client.add(...)` in `services/torrent.ts`. Today, sequential mode relies on WebTorrent's default — `docs/technical-design.md` §5 claims it, the code doesn't assert it.
- **A4.** Resolve brand drift. Pick one of `castcrate` / `Llama Spit Stream` and align across:
  - `apps/web/index.html` (currently `Llama Spit Stream`)
  - `lib/config.ts` `DOWNLOAD_PATH` default (currently `~/Downloads/LlamaSpitStream`)
  - README and any other public-facing strings.
- **A5.** Update `apps/web/src/components/TorrentPicker.tsx`'s hardcoded "No compatible (1080p / 720p · x264) torrents found on YTS" copy to mention the actual sources tried (use the `tried` array — already returned from the API).

**Acceptance:** `pnpm typecheck` and `pnpm test` pass; `.env.example` lints (manual diff against `lib/config.ts`).

---

### Phase B — Server hardening (1 day)

Behaviour fixes, all server-side. Each is independently mergeable.

- **B1.** Atomic `history.json` writes. `services/history.ts` currently does `writeFile(path, json)` straight; a crash mid-write corrupts the file. Switch to `writeFile(path + ".tmp", json)` + `rename(path + ".tmp", path)`.
- **B2.** ffmpeg subprocess registry + cleanup. `services/transcoder.ts` registers no Fastify `onClose` hook; live transcodes orphan when the server is killed. Track active subprocesses in a Set; register an `onClose` hook that kills each.
- **B3.** Append history on cast start, not just on torrent removal. `routes/cast.ts` `/api/cast/play` should call `appendHistory(...)` after `cast.play(...)` succeeds. Today, cast-only sessions (no removal) leave no trace.
- **B4.** Pre-buffer / stalled-stream timeout. `routes/torrents.ts` `/stream/:hash` currently issues `file.createReadStream({ start, end })` which blocks indefinitely if the bytes never arrive. Add a 30s timeout that returns 504 (or aborts the response) instead.
- **B5.** Re-check ffmpeg on smooth-playback toggle. `services/transcoder.ts.checkFfmpeg()` caches forever; if the user installs ffmpeg mid-session, the toggle stays disabled until restart. Add a `revalidateFfmpeg()` invoked from `/api/system/check` (or from a new lightweight `/api/system/ffmpeg/recheck`).

**Acceptance:**
- `pnpm test` covers atomic-write recovery and ffmpeg cleanup.
- Manual: `kill -9 $serverPid` mid-stream → no orphan ffmpeg in `pgrep -f ffmpeg`.
- Manual: cast a movie without ever removing it → entry appears in `~/.castcrate/history.json`.

---

### Phase C — UX polish (½–1 day)

Client-side fixes that make the existing flows less surprising.

- **C1.** "Delete files on disk?" prompt on torrent removal. `Library.tsx` "Remove" today drops the torrent from the WebTorrent client without touching disk. Confirm dialog with two buttons: "Stop only" / "Stop & delete files". The latter sends `?destroy=true` to `DELETE /api/torrent/:hash`, which forwards to WebTorrent's `destroyStore: true` option.
- **C2.** Optimistic UI on seek/volume. `CastControls.tsx` polls every 1s; until the next poll, the slider snaps back to the old value. Update local state immediately on `onChange`; reconcile when the next poll arrives.
- **C3.** Stalled-stream UI. When `progress` hasn't changed in 10s while not `done`, show a "Stream stalled — no peers" warning in `Player.tsx`.
- **C4.** Stop-or-slow status polling once `done === true`. `Player.tsx` polls torrent status at 1500ms unconditionally; once finished, drop to 30s or stop.

**Acceptance:**
- Manual: drag the seek bar — slider does not snap back.
- Manual: kill all peers mid-stream — UI shows stalled warning within 10s.
- Manual: completed torrent — devtools shows `/api/torrent/:hash` polling reduced.

---

### Phase D — Test coverage (1 day)

Fill the test gaps the discovery pass identified, plus CI.

- **D1.** Vitest fixtures for `services/omdb.ts`. Recorded responses for: search, detail, season episodes, error paths (401 invalid key, 502 DNS, silent empty for "Too many results").
- **D2.** Vitest fixtures for `services/knaben.ts` API responses (success, empty, error, malformed).
- **D3.** Integration test for `DELETE /api/torrent/:hash` → `appendHistory` write path.
- **D4.** Corrupted-JSON recovery test for `services/history.ts` (missing file, malformed JSON, partial write).
- **D5.** GitHub Actions CI: `pnpm typecheck`, `pnpm lint`, `pnpm test` on PR + push to main. Single workflow, Node 22, pnpm 11. No deploy step.

**Acceptance:** `pnpm test` green on a fresh checkout; CI fires on this branch's PR.

---

### Phase E — Deferred (architectural)

Not in scope for this feature. Listed so we don't lose track.

- **E1.** WebSocket push for cast + torrent state (replace polling). Plugin already registered, listeners wired. Worth a separate feature.
- **E2.** Auto-transcode trigger from codec probe (HEVC, AV1, >8 Mbps source). `docs/technical-design.md` §5 promised this; today the toggle is purely user-controlled.
- **E3.** Manual file picker for multi-file torrents (today `pickVideoFile = largest by size` — wrong for season packs).
- **E4.** Editable settings (PATCH `/api/settings` writing to `~/.castcrate/settings.json`).
- **E5.** Knaben season-pack search path (currently EZTV-only).
- **E6.** Per-indexer DNS bypass scoping (today's monkey-patch is global).

Each of these is a feature in its own right; spawn `/start-feature` workstreams when ready.

---

## Cross-references

The fixes above are linked to specific findings in the per-phase docs. When implementing each item, read the linked doc's "Gotchas" section for full context:

| Item | Source doc |
|---|---|
| A1 (env vars) | `scaffold`, `transcoding`, `knaben-fallback` — Gotchas |
| A3 (sequential flag) | `yts-streaming` — Gotchas |
| A4 (brand drift) | `scaffold` — Gotchas |
| A5 ("YTS only" copy) | `omdb-search` — Gotchas |
| B1 (atomic writes) | `library-settings` — Gotchas |
| B2 (ffmpeg cleanup) | `transcoding` — Gotchas |
| B3 (history on cast start) | `library-settings` — Gotchas |
| B4 (stream timeout) | `yts-streaming` — Gotchas |
| B5 (ffmpeg recheck) | `transcoding` — Gotchas |
| C1 (delete-files prompt) | `library-settings` — Gotchas |
| C2 (optimistic UI) | `cast-controls` — Gotchas |

## Out of scope

- WebSocket migration (Phase E1)
- Auto-transcode codec probe (Phase E2)
- Manual file picker (Phase E3)
- Editable settings (Phase E4)
- Anything in the "Future enhancements / Low priority" sections of the per-phase docs

If a fix grows beyond a few files, stop and split it out as its own feature.
