export type ContentType = "movie" | "series";

export interface MovieSearchResult {
  imdbId: string;
  type: ContentType;
  title: string;
  year: number | null;
  poster: string | null;
  rating: number;
  overview: string;
}

export interface MovieDetails extends MovieSearchResult {
  runtime: number | null;
  genres: string[];
  cast: { name: string; character: string }[];
}

export interface SeriesDetails extends MovieDetails {
  totalSeasons: number;
}

export interface SeriesEpisode {
  imdbId: string;
  seriesImdbId: string;
  season: number;
  episode: number;
  title: string;
  released: string | null;
  rating: number;
  overview: string;
}

/** Per-adapter row emitted by the server's indexer fallback chain — server-side
 *  only for now. The `/api/search/torrents*` HTTP responses currently expose
 *  only the flat `tried: string[]` (adapter names in visit order) for backward
 *  compat with the web client's `extractTried()` parser. */
export interface TriedEntry {
  /** Adapter identifier — matches `TorrentResult.source` where applicable. */
  name: string;
  /** Number of results this adapter produced. */
  count: number;
  /** Populated when the adapter threw. Kept structured to preserve the mixed
   *  string/object error shape today's route surfaces to the client. */
  error?:
    | string
    | { source: string; code: string; addonId?: string; addonName?: string };
}

export interface TorrentResult {
  title: string;
  magnet: string;
  size: string;
  sizeBytes: number;
  seeds: number;
  peers: number;
  resolution: "480p" | "720p" | "1080p" | "2160p" | "unknown";
  videoCodec: string;
  source: "yts" | "eztv" | "knaben" | "torrentday" | "stremio";
  // For TV: which episode (or season pack with episode=0)
  season?: number;
  episode?: number;
  // Whether this codec/quality is expected to play on a default Chromecast.
  // false → user gets a "may not play on older Chromecasts" hint.
  castFriendly: boolean;
  /** Absolute URL to the .torrent file — set for sources that use blob downloads
   *  instead of magnets (e.g. private trackers like TorrentDay). */
  torrentUrl?: string;
  /** Direct HTTP stream URL — when set, bypass webtorrent entirely (e.g. debrid-cached streams). */
  streamUrl?: string;
  /** Index of the specific file within a multi-file torrent to play. */
  fileIdx?: number;
  /** Name of the Stremio addon that provided this result, e.g. "Torrentio". */
  addonOrigin?: string;
}

export interface CastDevice {
  id: string;
  name: string;
  ip: string;
  port: number;
}

export interface TorrentStatus {
  infoHash: string;
  progress: number;
  downloadSpeed: number;
  peers: number;
  done: boolean;
}

export type CastSessionState =
  | "buffering"
  | "playing"
  | "paused"
  | "stopped"
  /** Server-side heartbeat has failed N consecutive times — the receiver is
   *  unreachable (device powered off, LAN disconnected, Chromecast rebooted).
   *  UI should surface a banner and stop polling. */
  | "disconnected";

export interface CastSession {
  sessionId: string;
  deviceId: string;
  status: CastSessionState;
}

export type CastAction = "play" | "pause" | "stop" | "seek" | "volume" | "mute" | "unmute";

export interface CastSessionStatus {
  sessionId: string;
  deviceId: string;
  /** Friendly device name — useful for disconnect banners on the client. */
  deviceName: string;
  status: CastSessionState;
  currentTime: number;
  duration: number;
  volumeLevel: number;
  muted: boolean;
}

/** One subtitle track passed to the Chromecast receiver as part of the initial
 *  LOAD payload. `trackId` is what the client references in `activeTrackIds`. */
export interface CastMediaTrack {
  trackId: number;
  url: string;
  language: string;
  name: string;
}

/** Payload for `POST /api/cast/sessions/:sessionId/tracks` — hot-swap the
 *  active subtitle set on an already-playing cast session via EDIT_TRACKS_INFO. */
export interface SetActiveTracksRequest {
  /** Empty array turns subtitles off; single element switches to that track. */
  activeTrackIds: number[];
}

/** One entry from `GET /stream/:hash/subtitles` — a discriminated union so the
 *  client knows which URL scheme to fetch. Torrent tracks are embedded in the
 *  torrent file list; OpenSubtitles tracks come from the external API and are
 *  fetched via `/api/subtitles/opensubtitles/:fileId`. */
export type SubtitleTrack =
  | TorrentSubtitleTrack
  | OpenSubtitlesSubtitleTrack;

/** Subtitle track embedded in the torrent's file list — served by
 *  `/stream/:hash/subtitles/:index`. */
export interface TorrentSubtitleTrack {
  source: "torrent";
  /** Position in the torrent-embedded track list (0-based). Used both as a
   *  URL path segment for the body endpoint and as the basis for the
   *  Chromecast trackId (`index + 1`). */
  index: number;
  fileName: string;
  language: string;
  ext: ".srt" | ".vtt";
}

/** Subtitle track discovered via OpenSubtitles — served by
 *  `/api/subtitles/opensubtitles/:fileId` (also VTT, converted server-side). */
export interface OpenSubtitlesSubtitleTrack {
  source: "opensubtitles";
  /** Synthetic id, e.g. `"os:1234567"`. Includes the `os:` prefix so callers
   *  can pass it around opaquely without confusing it with a bare file id. */
  id: string;
  /** OpenSubtitles' file_id (numeric string). Used as the URL path segment
   *  for the body endpoint. */
  fileId: string;
  /** ISO 639-1 language code (`"en"`, `"ja"`). */
  language: string;
  /** Human-readable language name, e.g. `"English"`. */
  languageName: string;
  /** Release string returned by OpenSubtitles — useful for disambiguating
   *  multiple tracks in the same language (e.g. "YIFY vs. HD-1080p").
   *  Optional; not every OS entry has one. */
  releaseName?: string;
  /** Download count reported by OpenSubtitles. Higher = more popular. Used
   *  for sorting in the picker. */
  downloadCount?: number;
}

/** VPN routing mode surfaced by the server.
 *
 *  - `"off"` — default; macOS dev or explicit `VPN_MODE=off`. Fastify runs on
 *    the host and no netns is configured. No probe issued; `/api/system/vpn-health`
 *    short-circuits to a static `mode:"off"` response.
 *  - `"vpn"` — full-tunnel (v1). Fastify runs INSIDE `castcrate-ns`; all
 *    outbound egress (indexers, torrent peers, metadata, subtitles, DHT)
 *    exits via the WireGuard tunnel.
 *  - `"torrentday-only"` — split (v2). Fastify runs on the host at full
 *    throughput; only the TorrentDay adapter's HTTP fetches are spawned into
 *    the ns via `ip netns exec castcrate-ns node td-fetcher.js <url>`.
 *    Everything else (WebTorrent peers, other indexers, subtitles, cast) uses
 *    host clearnet.
 *  - `"unknown"` — reserved for in-flight first-probe states; not currently
 *    emitted by any mode. */
export type VpnMode = "vpn" | "torrentday-only" | "off" | "unknown";

/** Health snapshot returned by `GET /api/system/vpn-health`. Cached server-side
 *  for 30s; `?refresh=1` bypasses. See `vpn-split-tunnel` feature for shape
 *  rationale (Decision D2). */
export interface VpnHealth {
  /** Where the probe was sourced from — describes the probe path, not where
   *  Fastify runs. Under `"vpn"` mode Fastify itself is inside the ns and the
   *  probe uses direct fetch. Under `"torrentday-only"` mode Fastify runs on
   *  the host but the probe is spawned into the ns via `ns-fetcher.js`, so
   *  `publicIp` still reports the WG tunnel's exit IP. */
  mode: VpnMode;
  /** Public IP observed from the probe (Cloudflare `1.1.1.1/cdn-cgi/trace`).
   *  null when the probe is skipped (`mode==="off"`), still pending, or has
   *  failed. */
  publicIp: string | null;
  /** ISO 3166-1 alpha-2 country code from the lookup, uppercase. null when
   *  the probe is skipped or the lookup did not return one. */
  country: string | null;
  /** WG peer endpoint `host:port` from `wg show wg-castcrate endpoints`.
   *  null when `wg` is not present (macOS dev), the peer has no active
   *  endpoint, or the probe was skipped. */
  wgPeer: string | null;
  /** True when the last outbound probe returned a 2xx within the timeout. */
  reachable: boolean;
  /** True when `publicIp === HOST_CLEARNET_IP` — i.e. the tunnel is up but
   *  not rewriting egress (leak). Always false when `mode==="off"` and when
   *  `HOST_CLEARNET_IP` is unset (no baseline to compare against). */
  leaking: boolean;
  /** Unix ms of the last successful probe. null if never succeeded (or
   *  `mode==="off"` — the off short-circuit does not touch the timestamp). */
  lastCheckedAt: number | null;
}

// -----------------------------------------------------------------------------
// watch-later feature — queue + library types
// -----------------------------------------------------------------------------

export type LibraryStatus = "queued" | "downloading" | "completed";

/** One row of ~/.castcrate/library.json.
 *  `hash` is null while a magnet is still being resolved (fetch-metadata phase);
 *  `filePath` is null until the download completes; `completedAt` is null
 *  until the same moment. `pinned` is orthogonal to state and controls
 *  retention-prune eligibility only. */
export interface LibraryItem {
  /** Client-stable id. Generated server-side on add — `crypto.randomUUID()`.
   *  Independent of `hash` so we can reference an item even before metadata
   *  resolves. */
  id: string;
  /** Magnet URI. Present for magnet-added items; absent when the item came
   *  from a .torrent blob (rare — TorrentDay). */
  magnet: string | null;
  /** WebTorrent infoHash (lowercase). Null until metadata resolves. Once
   *  set, becomes the dedupe key. */
  hash: string | null;
  /** Snapshot of metadata at add-time, so display works even if OMDB/TMDB
   *  is down when the user opens Library. */
  title: string;
  year: number | null;
  poster: string | null;
  imdbId: string | null;
  /** Which torrent source produced this — mirrors TorrentResult.source. */
  source: "yts" | "eztv" | "knaben" | "torrentday" | "stremio" | "unknown";
  /** ISO 8601 add time. */
  addedAt: string;
  /** ISO 8601 completion time; null while queued/downloading. */
  completedAt: string | null;
  /** Path (relative to DOWNLOAD_PATH) to the picked video file inside the
   *  torrent. Null until completion. Written by the download-queue worker. */
  filePath: string | null;
  /** Retention-prune exclusion flag. Inviolable — a pinned entry's file
   *  MUST NOT be deleted by castcrate-prune.service. */
  pinned: boolean;
}

/** Wire shape returned by `GET /api/library`. Sections are pre-sorted
 *  add-date desc so the client renders straight from the payload. */
export interface LibraryListResponse {
  queued: LibraryItem[]; // completedAt === null && hash === null
  downloading: LibraryItem[]; // completedAt === null && hash !== null
  completed: LibraryItem[]; // completedAt !== null
}

/** POST /api/library/queue request. Metadata is captured at add-time
 *  from whichever search source produced the row — the queue never
 *  re-fetches. */
export interface AddToQueueRequest {
  magnet: string;
  metadata: {
    title: string;
    year: number | null;
    poster: string | null;
    imdbId: string | null;
    source: LibraryItem["source"];
  };
}

export interface AddToQueueResponse {
  id: string;
  alreadyPresent: boolean;
}

/** POST /api/library/:id/play response — the client uses `streamUrl`
 *  to redirect straight to the player. `hash` is exposed for cast + status
 *  polling consistency with the existing torrent surface. */
export interface LibraryPlayResponse {
  streamUrl: string;
  hash: string;
}
