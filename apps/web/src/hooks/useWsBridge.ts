import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ActiveTorrent } from "../lib/api";

interface TorrentListMsg {
  type: "torrent:list";
  torrents: ActiveTorrent[];
}
interface CastStatusMsg {
  type: "cast:status";
  session: { sessionId: string } & Record<string, unknown>;
}
interface CastClosedMsg {
  type: "cast:closed";
  sessionId: string;
}
interface CastDisconnectedMsg {
  type: "cast:disconnected";
  sessionId: string;
  deviceName: string;
}
type ServerMsg =
  | TorrentListMsg
  | CastStatusMsg
  | CastClosedMsg
  | CastDisconnectedMsg;

/**
 * Open a single WebSocket to /ws on app mount and route server-pushed events
 * into the TanStack Query cache. The REST endpoints still exist as a
 * fallback for initial state and for slow-poll refresh when the WS drops.
 */
export function useWsBridge(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(url);
      ws.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(e.data) as ServerMsg;
          if (msg.type === "torrent:list") {
            qc.setQueryData(["torrents-active"], { torrents: msg.torrents });
            // Hydrate the per-infoHash status cache too — the Player reads it.
            for (const t of msg.torrents) {
              qc.setQueryData(["torrent-status", t.infoHash], t);
            }
          } else if (msg.type === "cast:status") {
            const id = msg.session?.sessionId;
            if (id) qc.setQueryData(["cast-session", id], msg.session);
          } else if (msg.type === "cast:disconnected") {
            // The server also broadcasts a `cast:status` with status:
            // "disconnected" right after, so the cache will end up with the
            // full disconnected snapshot either way. Merge here defensively
            // in case the status message is dropped or arrives first with
            // stale data.
            qc.setQueryData<Record<string, unknown> | undefined>(
              ["cast-session", msg.sessionId],
              (prev) => ({
                ...(prev ?? {}),
                sessionId: msg.sessionId,
                deviceName: msg.deviceName,
                status: "disconnected",
              }),
            );
          } else if (msg.type === "cast:closed") {
            qc.removeQueries({ queryKey: ["cast-session", msg.sessionId] });
          }
        } catch {
          /* ignore malformed payloads */
        }
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        // Backoff is intentionally simple — 2s. The user is on a LAN; either
        // the server is restarting or it's gone for good.
        reconnectTimer = window.setTimeout(connect, 2000);
      });
      ws.addEventListener("error", () => ws?.close());
    };
    connect();

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [qc]);
}
