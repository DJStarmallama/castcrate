import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import { searchTorrents } from "../services/yts.js";
import {
  startTorrent,
  getStatus,
  getVideoFile,
  removeTorrent,
} from "../services/torrent.js";

function extToMime(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
}

function parseRange(header: string | undefined, size: number) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  let start: number;
  let end: number;
  if (startStr === "" && endStr !== "") {
    // suffix range: last N bytes
    const suffix = Number(endStr);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = startStr === "" ? 0 : Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end >= size ||
    start > end
  ) {
    return null;
  }
  return { start, end };
}

export async function torrentRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { title?: string; year?: string } }>(
    "/api/search/torrents",
    async (req, reply) => {
      const title = (req.query.title ?? "").trim();
      if (!title) {
        return reply.code(400).send({ error: "title is required" });
      }
      const year = req.query.year ? Number(req.query.year) : undefined;
      try {
        const results = await searchTorrents(title, year);
        return { results };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "torrent search failed";
        return reply.code(502).send({ error: msg });
      }
    },
  );

  app.post<{ Body: { magnet?: string } }>("/api/torrent/start", async (req, reply) => {
    const magnet = req.body?.magnet;
    if (!magnet || !magnet.startsWith("magnet:")) {
      return reply.code(400).send({ error: "valid magnet link required" });
    }
    try {
      const session = await startTorrent(magnet);
      return {
        infoHash: session.infoHash,
        videoName: session.videoName,
        videoLength: session.videoLength,
        streamUrl: `/stream/${session.infoHash}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "failed to start torrent";
      return reply.code(500).send({ error: msg });
    }
  });

  app.get<{ Params: { infoHash: string } }>(
    "/api/torrent/:infoHash",
    async (req, reply) => {
      const status = await getStatus(req.params.infoHash);
      if (!status) return reply.code(404).send({ error: "not found" });
      return status;
    },
  );

  app.delete<{ Params: { infoHash: string } }>(
    "/api/torrent/:infoHash",
    async (req, reply) => {
      try {
        await removeTorrent(req.params.infoHash);
        return reply.code(204).send();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "failed to remove";
        return reply.code(500).send({ error: msg });
      }
    },
  );

  app.get<{ Params: { infoHash: string } }>(
    "/stream/:infoHash",
    async (req, reply) => {
      const file = await getVideoFile(req.params.infoHash);
      if (!file) {
        return reply.code(404).send({ error: "torrent not found" });
      }
      const size = file.length;
      const contentType = extToMime(file.name);
      const range = parseRange(req.headers.range, size);

      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Type", contentType);

      if (range) {
        const { start, end } = range;
        reply.code(206);
        reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
        reply.header("Content-Length", String(end - start + 1));
        return reply.send(file.createReadStream({ start, end }));
      }
      reply.header("Content-Length", String(size));
      return reply.send(file.createReadStream());
    },
  );
}
