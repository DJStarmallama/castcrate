import type { FastifyInstance } from "fastify";
import { listSubtitles, readSubtitleVtt } from "../services/subtitles.js";

export async function subtitleRoutes(app: FastifyInstance) {
  app.get<{ Params: { infoHash: string } }>(
    "/stream/:infoHash/subtitles",
    async (req, reply) => {
      const tracks = await listSubtitles(req.params.infoHash);
      return reply
        .header("Cache-Control", "no-store")
        .send({ tracks });
    },
  );

  app.get<{ Params: { infoHash: string; index: string } }>(
    "/stream/:infoHash/subtitles/:index",
    async (req, reply) => {
      const idx = Number(req.params.index);
      if (!Number.isInteger(idx) || idx < 0) {
        return reply.code(400).send({ error: "invalid index" });
      }
      const vtt = await readSubtitleVtt(req.params.infoHash, idx);
      if (vtt === null) {
        return reply.code(404).send({ error: "subtitle track not found" });
      }
      reply.header("Content-Type", "text/vtt; charset=utf-8");
      // Permissive CORS — Chromecast and the Vite proxy both fetch this
      reply.header("Access-Control-Allow-Origin", "*");
      return reply.send(vtt);
    },
  );
}
