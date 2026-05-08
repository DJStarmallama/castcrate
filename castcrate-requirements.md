# CastCrate – Product Requirements Document

> **Version:** 0.1.0  
> **Status:** Draft  
> **Last Updated:** 2026-05-08

---

## 1. Overview

CastCrate is a locally-hosted web application that lets a user search for movies, automatically locate and download the best-matching torrent, stream the file as it downloads, and cast the stream directly to a Chromecast device — all from a single UI running on their laptop.

---

## 2. Goals & Non-Goals

### Goals
- Provide a clean, title-screen-style UI for movie discovery and search.
- Integrate with public movie metadata APIs (e.g. TMDB) to surface rich movie info.
- Query torrent indexers/APIs to find the best quality match for a chosen title.
- Download the torrent via a local torrent client (streaming/sequential mode).
- Expose the in-progress download as an HTTP media stream.
- Discover Chromecast devices on the local network and initiate a Cast session.
- Provide playback controls (play, pause, seek, stop, volume) via the Cast sender.

### Non-Goals
- Cloud hosting or multi-user support.
- DRM-protected content.
- Mobile app (web UI only, accessed from the laptop's browser).
- Subtitle search (v1 — may be added later).

---

## 3. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js (LTS) | Single runtime for backend |
| Framework | Express.js | REST API + static file serving |
| Torrent client | WebTorrent | Pure JS, supports streaming |
| Movie metadata | TMDB API | Free tier, rich poster/info data |
| Torrent search | Torrent-search-api / custom scraper | Supports multiple indexers |
| Cast integration | `castv2-client` or `nodecastor` | Local network mDNS discovery + Cast protocol |
| Frontend | Vite + React + Tailwind CSS | SPA, title-screen aesthetic |
| Local DB / state | SQLite (via `better-sqlite3`) | Persist search history, download state |

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────┐
│                  User's Browser (SPA)                │
│   Search UI → Movie Detail → Cast Control Panel      │
└────────────────────┬────────────────────────────────┘
                     │ HTTP / WebSocket
┌────────────────────▼────────────────────────────────┐
│              Express API Server (localhost)           │
│                                                       │
│  /api/search/movies   → TMDB metadata lookup         │
│  /api/search/torrents → Torrent indexer search       │
│  /api/torrent/start   → WebTorrent download + stream │
│  /api/cast/devices    → mDNS Chromecast discovery    │
│  /api/cast/play       → Initiate Cast session        │
│  /api/cast/control    → Playback commands            │
│  /stream/:infoHash    → HTTP byte-range media stream │
└───────┬──────────────┬────────────────┬─────────────┘
        │              │                │
   TMDB API      Torrent Indexer   WebTorrent Engine
                                        │
                              ┌─────────▼──────────┐
                              │  Chromecast Device  │
                              │  (local network)    │
                              └────────────────────┘
```

---

## 5. Feature Specifications

### 5.1 Title Screen / Movie Search

- Full-screen hero UI with a prominent search bar.
- As the user types, query **TMDB `/search/movie`** and display results as a card grid.
- Each card shows: movie poster, title, year, TMDB rating.
- Clicking a card opens a **Movie Detail Panel** with:
  - Full synopsis, genre tags, runtime, cast (from TMDB).
  - A **"Find & Cast"** CTA button.

### 5.2 Torrent Search & Selection

- On "Find & Cast", the app queries the torrent indexer for the movie title + year.
- Results are ranked by a scoring algorithm:
  - Prefer 1080p > 720p > 4K (based on client hardware).
  - Prefer higher seed counts.
  - Prefer known release groups (e.g. YTS, RARBG mirrors).
- The top result is auto-selected; the user can expand a list to choose manually.
- Display: resolution, file size, seeds, peers, source.

### 5.3 Download & Streaming

- Start a **WebTorrent** download in sequential (streaming) mode.
- Expose the downloading file as an HTTP stream at `/stream/:infoHash`.
- Show a download progress bar (% complete, download speed, ETA) via WebSocket.
- Buffer requirement before cast: configurable (default: 2% of file).

### 5.4 Chromecast Discovery & Casting

- On app start, run **mDNS discovery** to find Chromecast devices on the LAN.
- List discovered devices in the UI (name, IP).
- On cast initiation:
  - Launch the **Default Media Receiver** on the Chromecast.
  - Send the local stream URL (laptop's LAN IP + `/stream/:infoHash`).
  - Set correct MIME type (`video/mp4` or `video/x-matroska`).
- Cast must begin once the buffer threshold is reached.

### 5.5 Playback Controls

Controls displayed in the UI while a Cast session is active:

| Control | Action |
|---|---|
| Play / Pause | Toggle playback |
| Seek bar | Scrub to position |
| Volume slider | Adjust cast volume |
| Stop | End cast session, optionally delete torrent |
| Subtitle toggle | (v2) |

### 5.6 Download Management

- View active and completed downloads.
- Option to keep or delete torrent data after a session.
- Storage path configurable in settings (default: `~/Downloads/CastCrate`).

---

## 6. API Endpoints

### Movie Search
```
GET /api/search/movies?q={query}
→ { results: [{ tmdbId, title, year, poster, rating, overview }] }
```

### Torrent Search
```
GET /api/search/torrents?title={title}&year={year}
→ { results: [{ title, magnet, size, seeds, peers, resolution, source }] }
```

---

## 6a. YTS API Integration

YTS (`yts.mx`) provides a stable, documented public API for movie torrents and is the preferred primary source for v1.

### Base URL
```
https://yts.mx/api/v2
```

### Key Endpoints Used

**Search by title:**
```
GET /list_movies.json?query_term={title}&quality=1080p&sort_by=seeds
```

**Get movie details + torrent list:**
```
GET /movie_details.json?movie_id={id}&with_cast=true
```

### Response Mapping

| YTS field | CastCrate usage |
|---|---|
| `torrents[].url` | Direct `.torrent` file download (preferred over magnet) |
| `torrents[].magnet` (constructed) | Fallback: build from `torrents[].hash` + tracker list |
| `torrents[].quality` | Resolution label (`720p`, `1080p`, `2160p`) |
| `torrents[].video_codec` | Filter: prefer `x264` (MP4 container, Chromecast-safe) |
| `torrents[].seeds` | Ranking signal |
| `torrents[].size` | Display to user |
| `large_cover_image` | Poster passed to Cast metadata |

### Quality Selection Logic (v1)

```
Priority order:
1. 1080p + x264  ← ideal: HD and Chromecast-native
2. 720p  + x264  ← fallback if no 1080p
3. 1080p + x265  ← triggers transcoding pipeline (see §6b)
4. 2160p         ← deprioritised (bandwidth + transcode cost)
```

### Magnet Construction (fallback)
If only a hash is available:
```javascript
const trackers = [
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:80",
  "udp://tracker.coppersurfer.tk:6969",
  "udp://glotorrents.pw:6969/announce",
];
const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`
  + trackers.map(t => `&tr=${encodeURIComponent(t)}`).join("");
```

### Rate Limiting
YTS enforces soft rate limits. Add a 500ms debounce on torrent search calls and cache results in SQLite for 1 hour per `(title, year)` pair to avoid repeated hits.

### Start Torrent
```
POST /api/torrent/start
Body: { magnet: string }
→ { infoHash, streamUrl, status }
```

### Cast Devices
```
GET /api/cast/devices
→ { devices: [{ id, name, ip, port }] }
```

### Start Cast
```
POST /api/cast/play
Body: { deviceId: string, streamUrl: string, title: string, posterUrl: string }
→ { sessionId, status }
```

### Playback Control
```
POST /api/cast/control
Body: { sessionId: string, action: "play"|"pause"|"stop"|"seek"|"volume", value?: number }
→ { status }
```

---

## 6b. MKV Transcoding Architecture (x265 / non-MP4 sources)

Chromecast's Default Media Receiver only supports **MP4 containers with H.264 video and AAC/MP3 audio**. Any x265 (HEVC) or MKV source must be transcoded on-the-fly before casting.

### Detection

When a torrent's `video_codec` is `x265` or the file extension resolves to `.mkv`, flag the session as `transcoding: true`.

### Transcoding Pipeline

```
WebTorrent stream (MKV/x265)
        │
        ▼
  FFmpeg child process
  (stdin: torrent readable stream)
  (stdout: piped MP4 stream)
        │
        ▼
  Express /stream/:infoHash
  (Content-Type: video/mp4)
        │
        ▼
  Chromecast Default Media Receiver
```

### FFmpeg Command (Node `child_process.spawn`)

```javascript
const ffmpeg = spawn("ffmpeg", [
  "-i", "pipe:0",          // stdin = torrent file stream
  "-c:v", "libx264",       // transcode video to H.264
  "-preset", "veryfast",   // balance speed vs quality (laptop CPU)
  "-crf", "23",            // quality factor
  "-c:a", "aac",           // transcode audio to AAC
  "-b:a", "192k",
  "-movflags", "frag_keyframe+empty_moov+faststart", // streaming-safe MP4
  "-f", "mp4",
  "pipe:1",                // stdout = Express response stream
]);

torrentFileStream.pipe(ffmpeg.stdin);
ffmpeg.stdout.pipe(res);  // pipe directly to HTTP response
```

### Key FFmpeg Flags

| Flag | Purpose |
|---|---|
| `frag_keyframe+empty_moov` | Produces a fragmented MP4 — required for streaming before the file is complete |
| `faststart` | Moves metadata to the front so the Chromecast can start before the full file arrives |
| `preset veryfast` | Keeps CPU load manageable on a laptop; `ultrafast` available as fallback |

### Buffer Requirement (transcoding sessions)

Increase the cast buffer threshold to **5%** (vs 2% for native MP4) to give FFmpeg time to build a lead over the Chromecast playhead.

### FFmpeg Prerequisite

```bash
# macOS
brew install ffmpeg

# Check at app startup — warn user if not found
which ffmpeg || echo "FFmpeg not installed — x265 sources unavailable"
```

Add an `/api/system/check` endpoint that verifies FFmpeg is present and returns its version. Surface a warning banner in the UI if it's missing.

### Transcoding Status in UI

When a transcoding session is active, show:
- A `⚡ Transcoding` badge on the Now Playing panel.
- CPU usage indicator (read from `os.loadavg()`).
- A note: *"Transcoding in progress — seeking may be limited."*

> **Note:** Seeking into an in-progress transcode is non-trivial. For v1, seeking is disabled for transcoded streams. The seek bar is shown but locked with a tooltip explanation. Full seek support (via FFmpeg `-ss` restart) is a v2 item.

---

## 7. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Cast latency (click → playing) | < 30s (including 2% buffer) |
| Search response time | < 1.5s (TMDB + torrent combined) |
| Supported OS | macOS (primary), Linux |
| Supported browsers | Chrome / Chromium (required for Cast API) |
| Max concurrent downloads | 3 |
| Local port | 3000 (API) + 5173 (dev frontend) |

---

## 8. Setup & Environment

```bash
# Required env vars (.env)
TMDB_API_KEY=your_tmdb_v3_key
DOWNLOAD_PATH=~/Downloads/CastCrate
PORT=3000
BUFFER_PERCENT=2
```

- Node.js v20+ required.
- No Docker needed — runs entirely on bare Node.
- Chromecast must be on the same WiFi network as the laptop.

---

## 9. Future Enhancements (v2+)

- [ ] Subtitle support (OpenSubtitles API, cast via Cast text tracks).
- [ ] Watch history and "continue watching".
- [ ] Multiple simultaneous Cast targets.
- [ ] TV show support (season/episode browsing).
- [ ] Hardware transcoding for MKV → MP4 (via FFmpeg).
- [ ] Dark/light theme toggle.
- [ ] Electron wrapper for a native desktop feel.

---

## 10. Legal Notice

> CastCrate is a tool for personal, local use only. Users are solely responsible for ensuring their use of this software complies with applicable copyright laws in their jurisdiction. The developers do not endorse or facilitate piracy.
