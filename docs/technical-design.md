# CastCrate

## Technical Design Document

**Companion to the [Mission Statement](./mission-statement.md). The mission captures *why* and *what*; this captures *how*.**

CastCrate is a solo-dev, single-user app that runs locally. Decisions favour fast iteration and visible behaviour over abstraction or scaling — when in doubt, keep things in one process and one file.

---

## 1. Stack & Environment

### Why TypeScript end-to-end

Single language across server, web, and shared types means the cross-process API contract is enforced at compile time without codegen. WebTorrent and `castv2-client` are JS-native, so Node was already required server-side; using TS on the web keeps the seam thin.

### Core technologies

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Node 22+ ESM | Native ESM, no transpile of server code in dev (`tsx watch`) |
| Server framework | Fastify 5 | Schema-first routes, first-class WebSocket support, fast cold start |
| Torrent client | WebTorrent | Sequential mode, streams from in-progress download, pure JS |
| Cast | `castv2-client` + `bonjour-service` | Direct mDNS discovery + Cast V2 protocol; no electron, no GUI |
| Transcode | FFmpeg subprocess | Real-time fragmented MP4, capped 5 Mbps for Chromecast compat |
| Web framework | Vite 8 + React 19 | Fastest dev loop; React 19 for `use` and improved Suspense |
| Styling | Tailwind v4 (`@tailwindcss/vite`) | Utility-only; no design system overhead |
| Server state | TanStack Query | Built-in retries, stale-while-revalidate for live torrent stats |
| Persistence | JSON file at `~/.castcrate/history.json` | One user, no concurrency, no schema migrations needed |
| Test | Vitest | Same toolchain across server and web |
| Package manager | pnpm 11 (workspaces) | Strict module resolution, native monorepo support |

### Hardware assumptions

- Mac/Linux laptop, on the same LAN as the Chromecast.
- LAN reachability: server binds `0.0.0.0:3000`; macOS firewall must allow incoming connections.
- VPN: Mullvad recommended; **Local network sharing must be ON** or LAN discovery and stream URLs break.

---

## 2. Project Structure

```
castcrate/
├── apps/
│   ├── server/            Fastify process — owns torrenting, casting, transcoding, search
│   │   └── src/
│   │       ├── index.ts           bootstrap + plugin registration
│   │       ├── routes/            HTTP/WS surface (cast, health, history, movies, subtitles, torrents)
│   │       ├── services/          domain logic (cast, discovery, eztv, history, knaben, omdb, subtitles, torrent, transcoder, yts)
│   │       ├── lib/               cross-cutting helpers (config, dns, network, quality, range, srt)
│   │       └── types/             server-internal types
│   └── web/               Vite + React UI
│       └── src/
│           ├── App.tsx, main.tsx
│           ├── components/        UI
│           ├── hooks/             TanStack Query wrappers, device-side state
│           └── lib/               client helpers
├── packages/
│   └── shared/            cross-process API contract types — imported by both apps
└── ~/.castcrate/history.json   user-local persistence
```

**Module boundaries:**

- `routes/` registers Fastify endpoints and validates inputs. No domain logic here.
- `services/` owns indexer adapters, the WebTorrent client wrapper, the cast session, the transcoder, and the history file. Each indexer (yts/eztv/knaben) is a thin adapter behind a shared shape.
- `lib/` is reusable helpers — pure functions where possible (`range.ts`, `quality.ts`).

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────┐
│  Browser (React SPA on :5173 dev / :3000 prod)│
│  Search → Detail/Episode picker → Cast panel  │
└──────────┬───────────────────────────────────┘
           │ HTTP + WebSocket
┌──────────▼───────────────────────────────────┐
│         Fastify server (0.0.0.0:3000)         │
│  routes ─→ services                           │
│   ├ /api/movies        → omdb.ts              │
│   ├ /api/torrents      → yts.ts / eztv.ts /   │
│   │                       knaben.ts (fallback)│
│   ├ /api/torrent/start → torrent.ts (WT)      │
│   ├ /stream/:hash      → range.ts + transcoder│
│   ├ /api/cast/devices  → discovery.ts (mDNS)  │
│   ├ /api/cast/play|control → cast.ts          │
│   ├ /api/history       → history.ts (JSON)    │
│   └ /api/subtitles     → subtitles.ts (SRT)   │
└──┬────────┬────────────┬────────┬────────────┘
   │        │            │        │
 OMDb    Indexers    WebTorrent  mDNS
                         │
                  ┌──────▼─────────┐
                  │  Chromecast    │
                  └────────────────┘
```

### Data flow: "play this title" path

1. **Search** — `GET /api/movies?q=…` → `omdb.ts` → metadata.
2. **Find torrent** — for movie: `yts.ts` (1080p x264 → 720p fallback). For TV: `eztv.ts` (single-episode → season-pack). On indexer failure: `knaben.ts` aggregator.
3. **Start torrent** — `POST /api/torrent/start` with magnet → `torrent.ts` adds to WebTorrent in sequential mode, returns `infoHash`.
4. **Wait for buffer** — UI polls torrent stats; once downloaded% ≥ `BUFFER_PERCENT`, "Cast" enables.
5. **Stream** — `GET /stream/:infoHash` serves byte-range from the in-progress file. If transcode is enabled in Settings (or codec mandates it), pipe through FFmpeg → fragmented MP4 capped at 5 Mbps.
6. **Cast** — `POST /api/cast/play` with `{ deviceId, streamUrl }` → `cast.ts` opens a Cast V2 session, loads the URL on the device.
7. **Control** — `POST /api/cast/control` → play/pause/seek/volume.
8. **Persist** — on cast start, append entry to `~/.castcrate/history.json`.

---

## 4. Indexer Adapter Pattern

Indexers are seized and rotated regularly. Mitigations:

- **Configurable base URLs.** YTS uses `YTS_BASE_URL` env (`movies-api.accel.li/api/v2` as of 2026-05). Override without code change.
- **Thin adapters.** Each adapter (`yts.ts`, `eztv.ts`, `knaben.ts`) maps a public API to the same internal `TorrentResult` shape. Swapping requires only that file.
- **Knaben as last-resort aggregator.** Searches multiple trackers; used when primary returns empty.
- **DNS bypass.** `lib/dns.ts` resolves indexer hosts directly when needed (e.g. ISP-level DNS blocks).

---

## 5. Streaming & Transcode

### HTTP byte-range from in-progress torrent

`lib/range.ts` parses `Range:` headers; `services/torrent.ts` exposes the WebTorrent file as a `Readable` stream sliced by byte offset. Sequential download mode ensures earlier offsets land first, so the head of the file is playable while the tail is still incoming.

### Transcode pipeline (Phase 6+)

`services/transcoder.ts` spawns FFmpeg with:
- `-c:v libx264 -preset veryfast -b:v 5M` (cap for Chromecast Gen 1/2 H.264 reliably)
- `-movflags frag_keyframe+empty_moov+default_base_moof` (fragmented MP4 over HTTP)
- `-c:a aac -ac 2` (Chromecast wants stereo AAC)

Toggled in Settings. Forced on when source codec is HEVC or bitrate exceeds 8 Mbps.

**Known limitation:** seek-during-transcode is not yet supported (see deferred items in README).

---

## 6. Cast & Discovery

- **Discovery** (`services/discovery.ts`) — `bonjour-service` browses `_googlecast._tcp.local`. Devices cached in memory; refreshed on demand.
- **Session** (`services/cast.ts`) — one active session at a time. The session owns the Cast V2 client and surfaces play/pause/seek/volume to routes.
- **Stream URL is LAN-relative.** The server picks the right outbound LAN IP via `lib/network.ts` and constructs URLs the Chromecast can actually reach (not `localhost`, not `127.0.0.1`).

---

## 7. Configuration

Loaded via `dotenv` at boot through `lib/config.ts`. Required and optional vars:

| Var | Required | Default | Notes |
|---|---|---|---|
| `OMDB_API_KEY` | yes | — | Movie/TV search |
| `DOWNLOAD_PATH` | no | `~/Downloads/CastCrate` | Torrent destination |
| `PORT` | no | `3000` | Server bind port |
| `BUFFER_PERCENT` | no | `2` | Pre-cast buffer threshold |
| `YTS_BASE_URL` | no | `https://movies-api.accel.li/api/v2` | Override when YTS rotates |

Env keys live in code as a single typed object exported from `lib/config.ts`.

---

## 8. Testing Strategy

- **Unit-test pure helpers.** `lib/range.ts`, `lib/quality.ts`, `lib/srt.ts` get tight Vitest coverage. These are deterministic.
- **Integration-test indexer adapters with recorded fixtures.** Don't hit live APIs in tests — record a representative response, assert the parser extracts the right fields.
- **Don't mock WebTorrent or `castv2-client`.** They're the integration risk. For these, manual end-to-end testing on real hardware is the floor; automated tests at most verify wiring.
- **Network gotchas need real-network verification.** mDNS discovery, Mullvad LAN sharing, firewall prompts — these can only be validated by running the app on a real LAN.

---

## 9. Development Principles

1. **One process, one file when possible.** The server is a monolith on purpose; splitting it would create deploy/IPC complexity for zero user benefit.
2. **Adapt to indexer churn cheaply.** New adapter = new file in `services/`, conforms to existing `TorrentResult` shape, registered in the router. Don't generalise the pattern further until there are 5+ indexers.
3. **Keep the torrent layer invisible to the UI.** The web app talks about "the movie" and "the episode", not info-hashes and seeders.
4. **Prefer Fastify lifecycle hooks over ad-hoc cleanup.** Long-lived resources (mDNS browser, WebTorrent client, FFmpeg subprocesses, cast sessions) must register `onClose` handlers.
5. **Strict TypeScript across the board.** No `any`. Cross-process types live in `@castcrate/shared` and are the source of truth for HTTP/WS payloads.
6. **No remote-access features.** If a feature requires a tunnel, auth, or a public origin, it doesn't fit. Add it to "What CastCrate Is Not" instead.

---

*This document evolves with the codebase. When a new phase or major feature lands, update the relevant section here before merging.*
