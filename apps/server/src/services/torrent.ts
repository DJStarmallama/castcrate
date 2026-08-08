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
    torrentId: string | Buffer,
    opts: { path: string; sequentialDownload?: boolean },
    cb: (torrent: WtTorrent) => void,
  ): WtTorrent;
  get(infoHash: string): WtTorrent | null | Promise<WtTorrent | null>;
  remove(
    infoHash: string,
    opts: { destroyStore?: boolean },
    cb?: (err?: Error) => void,
  ): void;
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
  videoCodec: string | null;
  startedAt: string;
  // Set when a history entry has already been written for this torrent
  // (e.g. on cast start). Removal uses this to update instead of duplicate.
  historyId?: string;
  // Index into the raw torrent.files array — overrides the
  // largest-video-file heuristic for season packs and similar.
  selectedFileIndex?: number;
}

const meta = new Map<string, TorrentMeta>();

export function setMeta(infoHash: string, m: TorrentMeta): void {
  meta.set(infoHash, m);
}

export function getMeta(infoHash: string): TorrentMeta | undefined {
  return meta.get(infoHash);
}

export function setMetaHistoryId(infoHash: string, historyId: string): void {
  const m = meta.get(infoHash);
  if (m) m.historyId = historyId;
}

export function setMetaSelectedFile(infoHash: string, index: number): void {
  const m = meta.get(infoHash);
  if (m) m.selectedFileIndex = index;
}

export async function startTorrent(
  input: string | Buffer,
  opts?: { fileIdx?: number },
): Promise<TorrentSession> {
  const client = await getClient();

  // Best-effort fast path for magnet strings — skip for Buffer inputs and let
  // webtorrent's own duplicate handling take care of deduplication.
  if (typeof input === "string") {
    for (const t of client.torrents) {
      if (input.includes(t.infoHash)) {
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
  }

  return new Promise<TorrentSession>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for torrent metadata (60s)")),
      60_000,
    );
    // sequentialDownload: stream the head of the file before the tail —
    // required for in-progress playback and byte-range requests to work.
    client.add(input, { path: config.downloadPath, sequentialDownload: true }, (torrent) => {
      const finalize = () => {
        let file: WtFile | null = null;

        // Honour an explicit fileIdx when provided and in range.
        const fileIdx = opts?.fileIdx;
        if (typeof fileIdx === "number") {
          if (fileIdx >= 0 && fileIdx < torrent.files.length) {
            file = torrent.files[fileIdx] ?? null;
          } else {
            // Out of range — warn and fall through to heuristic.
            console.warn(
              `startTorrent: fileIdx ${fileIdx} is out of range (torrent has ${torrent.files.length} files) — falling back to largest video file`,
            );
          }
        }

        // Fall back to heuristic when fileIdx is absent or was out of range.
        if (!file) {
          file = pickVideoFile(torrent.files);
        }

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

function resolveVideoFile(t: WtTorrent): WtFile | null {
  const m = meta.get(t.infoHash);
  if (m?.selectedFileIndex != null) {
    const f = t.files[m.selectedFileIndex];
    if (f && VIDEO_EXT.test(f.name)) return f;
  }
  return pickVideoFile(t.files);
}

export async function getVideoFile(infoHash: string): Promise<WtFile | null> {
  const t = await getTorrent(infoHash);
  if (!t) return null;
  return resolveVideoFile(t);
}

export interface VideoFileEntry {
  index: number;
  name: string;
  length: number;
}

export async function listVideoFiles(
  infoHash: string,
): Promise<VideoFileEntry[]> {
  const t = await getTorrent(infoHash);
  if (!t) return [];
  return t.files
    .map((f, index) => ({ index, name: f.name, length: f.length }))
    .filter((e) => VIDEO_EXT.test(e.name));
}

export async function selectVideoFile(
  infoHash: string,
  index: number,
): Promise<VideoFileEntry> {
  const t = await getTorrent(infoHash);
  if (!t) throw new Error("torrent not found");
  const f = t.files[index];
  if (!f || !VIDEO_EXT.test(f.name)) throw new Error("invalid file index");
  // Reprioritise downloads — drop the old selection, prioritise the new one
  // so its head bytes arrive first for streaming.
  for (const file of t.files) file.deselect();
  f.select(1);
  setMetaSelectedFile(infoHash, index);
  return { index, name: f.name, length: f.length };
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

export async function removeTorrent(
  infoHash: string,
  opts: { destroyStore?: boolean } = {},
): Promise<void> {
  const client = await getClient();
  meta.delete(infoHash);
  // webtorrent v2 throws synchronously ("No torrent with id ...") when the
  // torrent isn't in the client anymore. That throw escapes the callback
  // wrapper and crashes the process. Short-circuit so DELETE is idempotent.
  if (!client.get(infoHash)) return;
  return new Promise((resolve, reject) => {
    client.remove(infoHash, { destroyStore: opts.destroyStore }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

export async function shutdown(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise;
  return new Promise((resolve) => client.destroy(() => resolve()));
}
