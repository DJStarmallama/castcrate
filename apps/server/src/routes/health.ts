import type { FastifyInstance } from "fastify";
import { config } from "../lib/config.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/api/ping", async () => ({
    ok: true,
    service: "castcrate-server",
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/system/check", async () => ({
    ok: true,
    omdbConfigured: Boolean(config.omdbApiKey),
    downloadPath: config.downloadPath,
    bufferPercent: config.bufferPercent,
  }));
}
