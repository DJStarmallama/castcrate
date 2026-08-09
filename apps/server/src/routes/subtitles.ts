import type { FastifyInstance } from "fastify";
import {
  listSubtitles,
  readSubtitleVtt,
  readOpenSubtitleVtt,
} from "../services/subtitles.js";

export async function subtitleRoutes(app: FastifyInstance) {
  app.get<{
    Params: { infoHash: string };
    Querystring: { imdbId?: string; query?: string };
  }>("/stream/:infoHash/subtitles", async (req, reply) => {
    // Optional imdbId query enables the OpenSubtitles fallback branch inside
    // listSubtitles(). The web client passes it whenever movie metadata is
    // known; without it we return only torrent-embedded tracks.
    const opts: Parameters<typeof listSubtitles>[1] = {};
    if (req.query.imdbId) opts.imdbId = req.query.imdbId;
    if (req.query.query) opts.query = req.query.query;
    const tracks = await listSubtitles(req.params.infoHash, opts);
    return reply
      .header("Cache-Control", "no-store")
      .send({ tracks });
  });

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

  // OpenSubtitles-sourced body endpoint. Parallel to the torrent-embedded
  // route above: same content-type semantics, same CORS, same VTT output.
  // The path lives under /api/ (not /stream/) because there's no infoHash to
  // scope the file to — the file_id itself is globally unique across OS.
  //
  // The route accepts either the bare file id ("1234567") or the prefixed
  // id ("os:1234567") for consistency with what the picker holds client-side.
  app.get<{ Params: { fileId: string } }>(
    "/api/subtitles/opensubtitles/:fileId",
    async (req, reply) => {
      const raw = req.params.fileId;
      const bare = raw.startsWith("os:") ? raw.slice(3) : raw;
      if (!/^\d+$/.test(bare)) {
        return reply.code(400).send({ error: "invalid opensubtitles file id" });
      }
      try {
        const vtt = await readOpenSubtitleVtt(bare);
        reply.header("Content-Type", "text/vtt; charset=utf-8");
        reply.header("Access-Control-Allow-Origin", "*");
        return reply.send(vtt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "opensubtitles fetch failed";
        // 502 covers rate limit (429), quota (406), and generic upstream 5xx.
        // 503 when the adapter itself is disabled (no API key configured).
        const status = /not configured/i.test(msg) ? 503 : 502;
        return reply.code(status).send({ error: msg });
      }
    },
  );
}
