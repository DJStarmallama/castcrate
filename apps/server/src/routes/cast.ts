import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { CastAction } from "@castcrate/shared";
import { listDevices } from "../services/discovery.js";
import { play, control, getSession, type PlayParams } from "../services/cast.js";
import { getLanIp } from "../lib/network.js";
import { config } from "../lib/config.js";
import { getMeta, getStatus, setMetaHistoryId } from "../services/torrent.js";
import { appendHistory } from "../services/history.js";

// Extract infoHash from a streamPath like "/stream/abc123" or
// "/stream/abc123/transcoded". Returns null if the path doesn't match.
function infoHashFromStreamPath(streamPath: string): string | null {
  const m = /^\/stream\/([a-f0-9]+)/i.exec(streamPath);
  return m ? m[1]! : null;
}

const VALID_ACTIONS: ReadonlySet<CastAction> = new Set([
  "play",
  "pause",
  "stop",
  "seek",
  "volume",
  "mute",
  "unmute",
]);

interface PlayBody {
  deviceId?: string;
  streamPath?: string;
  title?: string;
  posterUrl?: string;
  contentType?: string;
  subtitlePath?: string;
  subtitleLanguage?: string;
  subtitleName?: string;
}

interface ControlBody {
  sessionId?: string;
  action?: string;
  value?: number;
}

export async function castRoutes(app: FastifyInstance) {
  app.get("/api/cast/devices", async () => ({ devices: listDevices() }));

  app.post<{ Body: PlayBody }>("/api/cast/play", async (req, reply) => {
    const {
      deviceId,
      streamPath,
      title,
      posterUrl,
      contentType,
      subtitlePath,
      subtitleLanguage,
      subtitleName,
    } = req.body ?? {};
    if (!deviceId || !streamPath || !title) {
      return reply.code(400).send({
        error: "deviceId, streamPath, and title are required",
      });
    }

    // Detect whether streamPath is already an absolute URL (e.g. a debrid CDN link
    // returned by the Stremio HTTP-stream branch in /api/torrent/start).
    const isAbsolute = /^https?:\/\//i.test(streamPath);

    // We need a LAN IP only when the stream URL must be constructed from the
    // relative path, or when a relative subtitle path is being attached.
    const needsLanIp = !isAbsolute || Boolean(subtitlePath);
    let ip: string | null = null;
    if (needsLanIp) {
      ip = getLanIp();
      if (!ip) {
        return reply.code(500).send({
          error: "Could not determine LAN IP for stream URL — is the laptop on a network?",
        });
      }
    }

    const streamUrl = isAbsolute
      ? streamPath
      : `http://${ip!}:${config.port}${streamPath}`;

    try {
      const params: PlayParams = {
        deviceId,
        streamUrl,
        title,
        ...(posterUrl ? { posterUrl } : {}),
        ...(contentType ? { contentType } : {}),
      };
      if (subtitlePath) {
        params.tracks = [
          {
            url: `http://${ip!}:${config.port}${subtitlePath}`,
            language: subtitleLanguage ?? "und",
            name: subtitleName ?? "Subtitles",
          },
        ];
      }
      const result = await play(params);

      // TODO(stremio): HTTP-stream history not tracked in v1 — would need synthetic ID
      // Record cast start in history. Removal will update this entry rather
      // than appending a duplicate (see DELETE /api/torrent/:infoHash).
      // infoHashFromStreamPath returns null for absolute URLs — the if-guard is a no-op.
      const infoHash = infoHashFromStreamPath(streamPath);
      if (infoHash) {
        const m = getMeta(infoHash);
        if (m && !m.historyId) {
          const status = await getStatus(infoHash);
          const now = new Date().toISOString();
          const historyId = randomUUID();
          await appendHistory({
            id: historyId,
            title: m.title,
            posterUrl: m.posterUrl,
            imdbId: m.imdbId,
            resolution: m.resolution,
            videoName: status?.name ?? title,
            startedAt: m.startedAt,
            endedAt: now,
            completed: false,
          });
          setMetaHistoryId(infoHash, historyId);
        }
      }

      return { ...result, streamUrl };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "cast failed";
      const status = msg.startsWith("device not found") ? 404 : 500;
      return reply.code(status).send({ error: msg });
    }
  });

  app.post<{ Body: ControlBody }>("/api/cast/control", async (req, reply) => {
    const { sessionId, action, value } = req.body ?? {};
    if (!sessionId || !action || !VALID_ACTIONS.has(action as CastAction)) {
      return reply.code(400).send({
        error: "sessionId and a valid action (play|pause|stop|seek|volume) are required",
      });
    }
    try {
      await control(sessionId, action as CastAction, value);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "control failed";
      return reply.code(500).send({ error: msg });
    }
  });

  app.get<{ Params: { sessionId: string } }>(
    "/api/cast/sessions/:sessionId",
    async (req, reply) => {
      const s = getSession(req.params.sessionId);
      if (!s) return reply.code(404).send({ error: "not found" });
      return s;
    },
  );
}
