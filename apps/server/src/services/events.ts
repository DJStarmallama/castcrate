import { listActiveTorrents, getMeta } from "./torrent.js";

// Minimal WebSocket type — we only ever call send/close and listen for
// close/error. Keeps us out of @fastify/websocket's internal types.
interface MinimalSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "close" | "error", cb: () => void): void;
}

const sockets = new Set<MinimalSocket>();

export function addSocket(s: MinimalSocket): void {
  sockets.add(s);
  const drop = () => sockets.delete(s);
  s.on("close", drop);
  s.on("error", drop);
}

export function broadcast(event: object): void {
  if (sockets.size === 0) return;
  const msg = JSON.stringify(event);
  for (const s of sockets) {
    if (s.readyState === 1 /* OPEN */) {
      try {
        s.send(msg);
      } catch {
        /* ignore — `error` listener will reap it */
      }
    }
  }
}

export function listenerCount(): number {
  return sockets.size;
}

let torrentInterval: NodeJS.Timeout | null = null;

/**
 * Start the periodic torrent-status broadcaster. Cast events are pushed
 * directly from `services/cast.ts` whenever the receiver fires a status
 * event, so they don't need a tick.
 */
export function startBroadcasters(intervalMs = 1000): void {
  if (torrentInterval) return;
  torrentInterval = setInterval(async () => {
    if (sockets.size === 0) return;
    try {
      const torrents = await listActiveTorrents();
      const decorated = torrents.map((t) => {
        const m = getMeta(t.infoHash);
        return {
          ...t,
          title: m?.title ?? t.name,
          posterUrl: m?.posterUrl ?? null,
          resolution: m?.resolution ?? null,
        };
      });
      broadcast({ type: "torrent:list", torrents: decorated });
    } catch {
      /* ignore — torrent service may not be ready yet */
    }
  }, intervalMs);
  torrentInterval.unref?.();
}

export function stopBroadcasters(): void {
  if (torrentInterval) {
    clearInterval(torrentInterval);
    torrentInterval = null;
  }
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  sockets.clear();
}
