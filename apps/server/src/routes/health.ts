import type { FastifyInstance } from "fastify";
import { config } from "../lib/config.js";
import { checkFfmpeg } from "../services/transcoder.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/api/ping", async () => ({
    ok: true,
    service: "castcrate-server",
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/system/check", async () => {
    const ff = await checkFfmpeg();
    return {
      ok: true,
      omdbConfigured: Boolean(config.omdbApiKey),
      downloadPath: config.downloadPath,
      bufferPercent: config.bufferPercent,
      transcodeBufferPercent: config.transcodeBufferPercent,
      transcodeBitrate: config.transcodeBitrate,
      ffmpeg: ff,
    };
  });
}
