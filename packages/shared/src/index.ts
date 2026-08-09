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
