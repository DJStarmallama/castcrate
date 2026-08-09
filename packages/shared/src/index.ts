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

export interface CastSession {
  sessionId: string;
  deviceId: string;
  status: "buffering" | "playing" | "paused" | "stopped";
}

export type CastAction = "play" | "pause" | "stop" | "seek" | "volume" | "mute" | "unmute";

export interface CastSessionStatus {
  sessionId: string;
  deviceId: string;
  status: "buffering" | "playing" | "paused" | "stopped";
  currentTime: number;
  duration: number;
  volumeLevel: number;
  muted: boolean;
}
