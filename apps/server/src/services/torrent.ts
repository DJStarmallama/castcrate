import { mkdirSync } from "node:fs";
import { config } from "../lib/config.js";

mkdirSync(config.downloadPath, { recursive: true });

import type { Readable } from "node:stream";

interface WtFile {
  name: string;
  length: number;
  done: boolean;
  select(priority?: number): void;
  deselect(): void;
  createReadStream(opts?: { start?: number; end?: number }): Readable;
}

interface WtTorrent {
  infoHash: string;
  name: string;
  files: WtFile[];
  ready: boolean;
  done: boolean;
  progress: number;
  downloadSpeed: number;
  numPeers: number;
  length: number;
  destroy(cb?: () => void): void;
  on(event: "ready" | "done" | "error", cb: (err?: Error) => void): void;
  once(event: "ready" | "done" | "error", cb: (err?: Error) => void): void;
}

interface WtClient {
  add(
    torrentId: string,
    opts: { path: string },
    cb: (torrent: WtTorrent) => void,
  ): WtTorrent;
  get(infoHash: string): WtTorrent | null | Promise<WtTorrent | null>;
  remove(infoHash: string, cb?: (err?: Error) => void): void;
  destroy(cb?: () => void): void;
  torrents: WtTorrent[];
}

const VIDEO_EXT = /\.(mp4|mkv|avi|m4v|webm)$/i;

function pickVideoFile(files: WtFile[]): WtFile | null {
  const videos = files.filter((f) => VIDEO_EXT.test(f.name));
  if (videos.length === 0) return null;
  return videos.reduce((best, f) => (f.length > best.length ? f : best), videos[0]!);
}

let clientPromise: Promise<WtClient> | null = null;

async function getClient(): Promise<WtClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const mod = (await import("webtorrent")) as unknown as {
        default: new () => WtClient;
      };
      const WebTorrent = mod.default;
      return new WebTorrent();
    })();
  }
  return clientPromise;
}

export interface TorrentSession {
  infoHash: string;
  name: string;
  videoName: string;
  videoLength: number;
}

export interface TorrentMeta {
  title: string;
  posterUrl: string | null;
  imdbId: string | null;
  resolution: string | null;
  startedAt: string;
}

const meta = new Map<string, TorrentMeta>();

export function setMeta(infoHash: string, m: TorrentMeta): void {
  meta.set(infoHash, m);
}

export function getMeta(infoHash: string): TorrentMeta | undefined {
  return meta.get(infoHash);
}

export async function startTorrent(magnet: string): Promise<TorrentSession> {
  const client = await getClient();

  // Best-effort fast path if already added
  for (const t of client.torrents) {
    if (magnet.includes(t.infoHash)) {
      const f = pickVideoFile(t.files);
      if (f) {
        return {
          infoHash: t.infoHash,
          name: t.name,
          videoName: f.name,
          videoLength: f.length,
        };
      }
    }
  }

  return new Promise<TorrentSession>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for torrent metadata (60s)")),
      60_000,
    );
    client.add(magnet, { path: config.downloadPath }, (torrent) => {
      const finalize = () => {
        const file = pickVideoFile(torrent.files);
        if (!file) {
          clearTimeout(timeout);
          reject(new Error("No video file found in torrent"));
          return;
        }
        for (const f of torrent.files) f.deselect();
        file.select(1);
        clearTimeout(timeout);
        const session: TorrentSession = {
          infoHash: torrent.infoHash,
          name: torrent.name,
          videoName: file.name,
          videoLength: file.length,
        };
        resolve(session);
      };
      if (torrent.ready) finalize();
      else torrent.once("ready", finalize);
      torrent.once("error", (err) => {
        clearTimeout(timeout);
        reject(err ?? new Error("torrent error"));
      });
    });
  });
}

export async function listActiveTorrents(): Promise<TorrentStatus[]> {
  const client = await getClient();
  const result: TorrentStatus[] = [];
  for (const t of client.torrents) {
    const f = pickVideoFile(t.files);
    result.push({
      infoHash: t.infoHash,
      name: t.name,
      progress: t.progress,
      downloadSpeed: t.downloadSpeed,
      numPeers: t.numPeers,
      done: t.done,
      videoLength: f?.length ?? 0,
    });
  }
  return result;
}

export async function getTorrent(infoHash: string): Promise<WtTorrent | null> {
  const client = await getClient();
  const t = await client.get(infoHash);
  return t ?? null;
}

export async function getVideoFile(infoHash: string): Promise<WtFile | null> {
  const t = await getTorrent(infoHash);
  if (!t) return null;
  return pickVideoFile(t.files);
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

export async function getStatus(infoHash: string): Promise<TorrentStatus | null> {
  const t = await getTorrent(infoHash);
  if (!t) return null;
  const f = pickVideoFile(t.files);
  return {
    infoHash: t.infoHash,
    name: t.name,
    progress: t.progress,
    downloadSpeed: t.downloadSpeed,
    numPeers: t.numPeers,
    done: t.done,
    videoLength: f?.length ?? 0,
  };
}

export async function removeTorrent(infoHash: string): Promise<void> {
  const client = await getClient();
  meta.delete(infoHash);
  return new Promise((resolve, reject) => {
    client.remove(infoHash, (err) => (err ? reject(err) : resolve()));
  });
}

export async function shutdown(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise;
  return new Promise((resolve) => client.destroy(() => resolve()));
}
