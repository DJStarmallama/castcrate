import type { FastifyInstance } from "fastify";
import { config } from "../lib/config.js";
import { checkFfmpeg } from "../services/transcoder.js";
import {
  getSettings,
  updateSettings,
  type RuntimeSettings,
} from "../services/settings.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/api/ping", async () => ({
    ok: true,
    service: "llama-spit-stream-server",
    timestamp: new Date().toISOString(),
  }));

  app.get<{ Querystring: { refresh?: string } }>(
    "/api/system/check",
    async (req) => {
      // ?refresh=1 forces a fresh ffmpeg probe — useful after the user installs
      // it without restarting the server.
      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const ff = await checkFfmpeg(refresh);
      const s = getSettings();
      return {
        ok: true,
        omdbConfigured: Boolean(config.omdbApiKey),
        downloadPath: config.downloadPath,
        bufferPercent: s.bufferPercent,
        transcodeBufferPercent: s.transcodeBufferPercent,
        transcodeBitrate: s.transcodeBitrate,
        ffmpeg: ff,
      };
    },
  );

  app.get("/api/settings", async () => getSettings());

  app.patch<{ Body: Partial<RuntimeSettings> }>(
    "/api/settings",
    async (req) => updateSettings(req.body ?? {}),
  );
}
