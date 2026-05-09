import type {
  CastAction,
  CastDevice,
  CastSessionStatus,
  MovieDetails,
  MovieSearchResult,
  SeriesDetails,
  SeriesEpisode,
  TorrentResult,
} from "@castcrate/shared";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail: string;
    try {
      const j = (await res.json()) as { error?: string };
      detail = j.error ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new ApiError(detail || res.statusText, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface StartTorrentResult {
  infoHash: string;
  videoName: string;
  videoLength: number;
  streamUrl: string;
  videoCodec: string | null;
}

export interface TorrentStatus {
  infoHash: string;
  name: string;
  progress: number;
  downloadSpeed: number;
  numPeers: number;
  done: boolean;
  videoLength: number;
}

export interface ActiveTorrent extends TorrentStatus {
  title: string;
  posterUrl: string | null;
  resolution: string | null;
}

export interface HistoryEntry {
  id: string;
  title: string;
  posterUrl: string | null;
  imdbId: string | null;
  resolution: string | null;
  videoName: string;
  startedAt: string;
  endedAt: string;
  completed: boolean;
}

export interface SystemCheck {
  ok: boolean;
  omdbConfigured: boolean;
  downloadPath: string;
  bufferPercent: number;
  transcodeBufferPercent: number;
  transcodeBitrate: string;
  ffmpeg: {
    available: boolean;
    version: string | null;
    path: string;
  };
}

export const api = {
  search: (q: string, type?: "movie" | "series") => {
    const url = new URL("/api/search", window.location.origin);
    url.searchParams.set("q", q);
    if (type) url.searchParams.set("type", type);
    return request<{ results: MovieSearchResult[] }>(url.pathname + url.search);
  },
  movieDetails: (imdbId: string) => request<MovieDetails>(`/api/movies/${imdbId}`),
  seriesDetails: (imdbId: string) => request<SeriesDetails>(`/api/series/${imdbId}`),
  seasonEpisodes: (imdbId: string, season: number) =>
    request<{ season: number; episodes: SeriesEpisode[] }>(
      `/api/series/${imdbId}/seasons/${season}`,
    ),
  searchTorrents: (title: string, year?: number) => {
    const url = new URL("/api/search/torrents", window.location.origin);
    url.searchParams.set("title", title);
    if (year) url.searchParams.set("year", String(year));
    return request<{ results: TorrentResult[]; tried?: string[] }>(
      url.pathname + url.search,
    );
  },
  searchEpisodeTorrents: (
    imdbId: string,
    season: number,
    episode: number,
    title?: string,
  ) => {
    const url = new URL("/api/search/torrents/episode", window.location.origin);
    url.searchParams.set("imdbId", imdbId);
    url.searchParams.set("season", String(season));
    url.searchParams.set("episode", String(episode));
    if (title) url.searchParams.set("title", title);
    return request<{
      episode: TorrentResult[];
      seasonPacks: TorrentResult[];
      tried?: string[];
    }>(url.pathname + url.search);
  },
  startTorrent: (params: {
    magnet: string;
    title?: string;
    posterUrl?: string | null;
    imdbId?: string | null;
    resolution?: string | null;
    videoCodec?: string | null;
  }) =>
    request<StartTorrentResult>("/api/torrent/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }),
  listTorrents: () => request<{ torrents: ActiveTorrent[] }>("/api/torrents"),
  history: () => request<{ entries: HistoryEntry[] }>("/api/history"),
  clearHistory: () => request<void>("/api/history", { method: "DELETE" }),
  systemCheck: () => request<SystemCheck>("/api/system/check"),
  torrentStatus: (infoHash: string) =>
    request<TorrentStatus>(`/api/torrent/${infoHash}`),
  removeTorrent: (infoHash: string, opts: { destroy?: boolean } = {}) => {
    const url = new URL(`/api/torrent/${infoHash}`, window.location.origin);
    if (opts.destroy) url.searchParams.set("destroy", "1");
    return request<void>(url.pathname + url.search, { method: "DELETE" });
  },
  castDevices: () => request<{ devices: CastDevice[] }>("/api/cast/devices"),
  castPlay: (body: {
    deviceId: string;
    streamPath: string;
    title: string;
    posterUrl?: string;
    contentType?: string;
    subtitlePath?: string;
    subtitleLanguage?: string;
    subtitleName?: string;
  }) =>
    request<{ sessionId: string; streamUrl: string }>("/api/cast/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  castControl: (sessionId: string, action: CastAction, value?: number) =>
    request<{ ok: true }>("/api/cast/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, action, value }),
    }),
  castSession: (sessionId: string) =>
    request<CastSessionStatus>(`/api/cast/sessions/${sessionId}`),
  subtitleTracks: (infoHash: string) =>
    request<{ tracks: SubtitleTrack[] }>(`/stream/${infoHash}/subtitles`),
};

export interface SubtitleTrack {
  index: number;
  fileName: string;
  language: string;
  ext: ".srt" | ".vtt";
}

export { ApiError };
