import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { searchTorrents } from "../services/yts.js";
import { searchEpisode, searchSeasonPack } from "../services/eztv.js";
import {
  startTorrent,
  getStatus,
  getVideoFile,
  removeTorrent,
  listActiveTorrents,
  setMeta,
  getMeta,
} from "../services/torrent.js";
import { appendHistory } from "../services/history.js";
import { parseRange } from "../lib/range.js";
import { spawnTranscode, checkFfmpeg } from "../services/transcoder.js";

function extToMime(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
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

  app.get<{
    Querystring: { imdbId?: string; season?: string; episode?: string };
  }>("/api/search/torrents/episode", async (req, reply) => {
    const imdbId = (req.query.imdbId ?? "").trim();
    const season = Number(req.query.season);
    const episode = Number(req.query.episode);
    if (!/^tt\d+$/.test(imdbId) || !Number.isInteger(season) || !Number.isInteger(episode)) {
      return reply.code(400).send({
        error: "imdbId (ttNNN), season, and episode are required",
      });
    }
    try {
      const [episodeResults, packResults] = await Promise.all([
        searchEpisode(imdbId, season, episode),
        searchSeasonPack(imdbId, season),
      ]);
      return {
        episode: episodeResults,
        seasonPacks: packResults,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "torrent search failed";
      return reply.code(502).send({ error: msg });
    }
  });

  app.post<{
    Body: {
      magnet?: string;
      title?: string;
      posterUrl?: string | null;
      imdbId?: string | null;
      resolution?: string | null;
    };
  }>("/api/torrent/start", async (req, reply) => {
    const magnet = req.body?.magnet;
    if (!magnet || !magnet.startsWith("magnet:")) {
      return reply.code(400).send({ error: "valid magnet link required" });
    }
    try {
      const session = await startTorrent(magnet);
      setMeta(session.infoHash, {
        title: req.body?.title ?? session.name,
        posterUrl: req.body?.posterUrl ?? null,
        imdbId: req.body?.imdbId ?? null,
        resolution: req.body?.resolution ?? null,
        startedAt: new Date().toISOString(),
      });
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

  app.get("/api/torrents", async () => {
    const active = await listActiveTorrents();
    return {
      torrents: active.map((t) => {
        const m = getMeta(t.infoHash);
        return {
          ...t,
          title: m?.title ?? t.name,
          posterUrl: m?.posterUrl ?? null,
          resolution: m?.resolution ?? null,
        };
      }),
    };
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
        const status = await getStatus(req.params.infoHash);
        const m = getMeta(req.params.infoHash);
        if (status && m) {
          await appendHistory({
            id: randomUUID(),
            title: m.title,
            posterUrl: m.posterUrl,
            imdbId: m.imdbId,
            resolution: m.resolution,
            videoName: status.name,
            startedAt: m.startedAt,
            endedAt: new Date().toISOString(),
            completed: status.done,
          });
        }
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

  app.get<{ Params: { infoHash: string } }>(
    "/stream/:infoHash/transcoded",
    async (req, reply) => {
      const ff = await checkFfmpeg();
      if (!ff.available) {
        return reply.code(503).send({
          error:
            "ffmpeg is not installed or not on PATH. Install with `brew install ffmpeg` to enable transcoding.",
        });
      }
      const file = await getVideoFile(req.params.infoHash);
      if (!file) {
        return reply.code(404).send({ error: "torrent not found" });
      }

      const source = file.createReadStream();
      const handle = spawnTranscode(source);

      let stderrBuf = "";
      handle.process.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
      });
      handle.process.on("error", (err) => {
        req.log.error({ err }, "ffmpeg spawn error");
      });
      handle.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          req.log.warn(
            { code, tail: stderrBuf.slice(-512) },
            "ffmpeg exited non-zero",
          );
        }
      });

      const cleanup = () => {
        try {
          source.unpipe?.(handle.process.stdin);
        } catch {
          /* ignore */
        }
        if (!handle.process.killed) {
          handle.process.kill("SIGTERM");
          setTimeout(() => {
            if (!handle.process.killed) handle.process.kill("SIGKILL");
          }, 1500).unref();
        }
      };
      req.raw.on("close", cleanup);

      reply.header("Content-Type", "video/mp4");
      // Transcoded streams are not seekable in v1; range requests are ignored.
      reply.header("Accept-Ranges", "none");
      reply.header("Cache-Control", "no-store");
      return reply.send(handle.stdout);
    },
  );
}
