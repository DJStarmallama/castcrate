export interface MovieSearchResult {
  tmdbId: number;
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

export interface TorrentResult {
  title: string;
  magnet: string;
  size: string;
  sizeBytes: number;
  seeds: number;
  peers: number;
  resolution: "720p" | "1080p" | "2160p";
  videoCodec: string;
  source: "yts";
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

export type CastAction = "play" | "pause" | "stop" | "seek" | "volume";
