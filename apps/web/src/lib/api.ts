import type {
  CastAction,
  CastDevice,
  MovieDetails,
  MovieSearchResult,
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
  tmdbId: number | null;
  resolution: string | null;
  videoName: string;
  startedAt: string;
  endedAt: string;
  completed: boolean;
}

export interface SystemCheck {
  ok: boolean;
  tmdbConfigured: boolean;
  downloadPath: string;
  bufferPercent: number;
}

export const api = {
  searchMovies: (q: string) =>
    request<{ results: MovieSearchResult[] }>(
      `/api/search/movies?q=${encodeURIComponent(q)}`,
    ),
  movieDetails: (tmdbId: number) => request<MovieDetails>(`/api/movies/${tmdbId}`),
  searchTorrents: (title: string, year?: number) => {
    const url = new URL("/api/search/torrents", window.location.origin);
    url.searchParams.set("title", title);
    if (year) url.searchParams.set("year", String(year));
    return request<{ results: TorrentResult[] }>(url.pathname + url.search);
  },
  startTorrent: (params: {
    magnet: string;
    title?: string;
    posterUrl?: string | null;
    tmdbId?: number | null;
    resolution?: string | null;
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
  removeTorrent: (infoHash: string) =>
    request<void>(`/api/torrent/${infoHash}`, { method: "DELETE" }),
  castDevices: () => request<{ devices: CastDevice[] }>("/api/cast/devices"),
  castPlay: (body: {
    deviceId: string;
    streamPath: string;
    title: string;
    posterUrl?: string;
    contentType?: string;
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
};

export { ApiError };
