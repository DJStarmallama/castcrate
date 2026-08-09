import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { ytsAdapter } from "../services/yts.js";
import { eztvAdapter } from "../services/eztv.js";
import { knabenAdapter } from "../services/knaben.js";
import { fetchTorrentBlob, torrentdayAdapter } from "../services/torrentday.js";
import { stremioAdapter } from "../services/stremio.js";
import {
  runFallback,
  triedNames,
  type AdapterError,
  type IndexerAdapter,
} from "../lib/indexers.js";
import {
  startTorrent,
  getStatus,
  getVideoFile,
  removeTorrent,
  listActiveTorrents,
  listVideoFiles,
  selectVideoFile,
  setMeta,
  getMeta,
} from "../services/torrent.js";
import { appendHistory, updateHistoryById } from "../services/history.js";
import { parseRange } from "../lib/range.js";
import { spawnTranscode, checkFfmpeg } from "../services/transcoder.js";
import { config } from "../lib/config.js";

// ---------------------------------------------------------------------------
// Fallback chains — order matters and matches the legacy inline order.
//   Movies:      YTS → Stremio → Knaben → TorrentDay
//   Episodes:    EZTV → Stremio → Knaben → TorrentDay
//   Season packs: EZTV → Knaben
// Adapters self-gate via `adapter.enabled(ctx)`, so a chain that includes
// TorrentDay still no-ops when `tdAvailable()` is false, matching the
// previous route's inline `if (tdAvailable())` guard.
// ---------------------------------------------------------------------------

const movieChain: IndexerAdapter[] = [
  ytsAdapter,
  stremioAdapter,
  knabenAdapter,
  torrentdayAdapter,
];

const episodeChain: IndexerAdapter[] = [
  eztvAdapter,
  stremioAdapter,
  knabenAdapter,
  torrentdayAdapter,
];

const seasonPackChain: IndexerAdapter[] = [eztvAdapter, knabenAdapter];

/**
 * Dedupes errors across multiple chain runs — the episode route runs two
 * chains (episode + season pack) and both may have visited the same adapter
 * (typically eztv). The old inline code emitted a single `eztv:` entry in
 * that case, and Knaben's episode/pack failures were distinguished by their
 * prefixes (`knaben (episode):` vs `knaben (pack):`) so both showed up
 * distinctly. Dedupe key covers both: string errors keyed by content,
 * object errors keyed by `(source, code, addonId)`.
 */
function mergeErrors(...groups: AdapterError[][]): AdapterError[] {
  const seen = new Set<string>();
  const out: AdapterError[] = [];
  for (const g of groups) {
    for (const err of g) {
      const key = typeof err === "string"
        ? `s::${err}`
        : `o::${err.source}::${err.code}::${err.addonId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(err);
    }
  }
  return out;
}

function waitForFirstByte(
  stream: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onReadable = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("first-byte timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("readable", onReadable);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    stream.once("readable", onReadable);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

function extToMime(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
}

export async function torrentRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { title?: string; year?: string; imdbId?: string } }>(
    "/api/search/torrents",
    async (req, reply) => {
      const title = (req.query.title ?? "").trim();
      if (!title) {
        return reply.code(400).send({ error: "title is required" });
      }
      const year = req.query.year ? Number(req.query.year) : undefined;

      // imdbId is optional — validate format; treat invalid values as absent.
      let imdbId: string | undefined = (req.query.imdbId ?? "").trim() || undefined;
      if (imdbId && !/^tt\d{5,}$/.test(imdbId)) {
        req.log.warn({ imdbId }, "stremio: imdbId query param has invalid format — ignoring");
        imdbId = undefined;
      }

      const outcome = await runFallback(
        movieChain,
        {
          title,
          ...(year !== undefined ? { year } : {}),
          ...(imdbId !== undefined ? { imdbId } : {}),
        },
        "movie",
      );

      const tried = triedNames(outcome.tried);
      if (outcome.results.length === 0 && outcome.errors.length > 0) {
        return reply
          .code(502)
          .send({ error: "all sources failed", tried, errors: outcome.errors });
      }
      return { results: outcome.results, tried };
    },
  );

  app.get<{
    Querystring: {
      imdbId?: string;
      season?: string;
      episode?: string;
      title?: string;
    };
  }>("/api/search/torrents/episode", async (req, reply) => {
    const imdbId = (req.query.imdbId ?? "").trim();
    const season = Number(req.query.season);
    const episode = Number(req.query.episode);
    const title = (req.query.title ?? "").trim();
    if (!/^tt\d+$/.test(imdbId) || !Number.isInteger(season) || !Number.isInteger(episode)) {
      return reply.code(400).send({
        error: "imdbId (ttNNN), season, and episode are required",
      });
    }

    // Two independent fallback chains: one for single-episode results, one
    // for season packs. Both start with EZTV (which is cached, so the second
    // call to `fetchAllTorrents` is free). `mergeTried`/`mergeErrors` collapse
    // duplicate entries so the wire response matches the legacy shape where
    // each adapter appears once even if it was visited by both chains.
    const episodeOutcome = await runFallback(
      episodeChain,
      {
        imdbId,
        season,
        episode,
        ...(title ? { title } : {}),
      },
      "episode",
    );

    const seasonPackOutcome = await runFallback(
      seasonPackChain,
      {
        imdbId,
        season,
        ...(title ? { title } : {}),
      },
      "seasonPack",
    );

    // `triedNames` dedupes by name — passing the concatenated tried arrays
    // collapses eztv (present in both chains) into a single entry.
    const tried = triedNames([...episodeOutcome.tried, ...seasonPackOutcome.tried]);
    const errors = mergeErrors(episodeOutcome.errors, seasonPackOutcome.errors);

    if (
      episodeOutcome.results.length === 0 &&
      seasonPackOutcome.results.length === 0 &&
      errors.length > 0
    ) {
      return reply.code(502).send({ error: "all sources failed", tried, errors });
    }

    return {
      episode: episodeOutcome.results,
      seasonPacks: seasonPackOutcome.results,
      tried,
    };
  });

  app.post<{
    Body: {
      magnet?: string;
      torrentUrl?: string;
      streamUrl?: string;
      source?: string;
      title?: string;
      posterUrl?: string | null;
      imdbId?: string | null;
      resolution?: string | null;
      videoCodec?: string | null;
    };
  }>("/api/torrent/start", async (req, reply) => {
    const { magnet, torrentUrl, streamUrl, source } = req.body ?? {};

    // Stremio HTTP-stream branch — external URL, bypass webtorrent entirely.
    if (source === "stremio" && streamUrl) {
      if (!/^https?:\/\//.test(streamUrl)) {
        return reply.code(400).send({ error: "streamUrl must be http(s)" });
      }
      // No setMeta() — HTTP streams are ephemeral, there is no infoHash to key on.
      return {
        infoHash: null,
        videoName: req.body?.title ?? "stream",
        videoLength: 0,
        streamUrl,          // absolute URL — cast.ts detects and passes through unchanged
        videoCodec: req.body?.videoCodec ?? null,
        transcodable: false,
      };
    }

    // TorrentDay results carry a torrentUrl (blob path) instead of a magnet.
    if (source === "torrentday") {
      if (!torrentUrl) {
        return reply.code(400).send({ error: "torrentUrl required for torrentday source" });
      }
      try {
        const blob = await fetchTorrentBlob(torrentUrl);
        const session = await startTorrent(blob);
        const videoCodec = req.body?.videoCodec ?? null;
        setMeta(session.infoHash, {
          title: req.body?.title ?? session.name,
          posterUrl: req.body?.posterUrl ?? null,
          imdbId: req.body?.imdbId ?? null,
          resolution: req.body?.resolution ?? null,
          videoCodec,
          startedAt: new Date().toISOString(),
        });
        return {
          infoHash: session.infoHash,
          videoName: session.videoName,
          videoLength: session.videoLength,
          streamUrl: `/stream/${session.infoHash}`,
          videoCodec,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "failed to fetch or start torrent";
        return reply.code(500).send({ error: msg });
      }
    }
    if (!magnet || !magnet.startsWith("magnet:")) {
      return reply.code(400).send({ error: "valid magnet link required" });
    }
    try {
      const session = await startTorrent(magnet);
      const videoCodec = req.body?.videoCodec ?? null;
      setMeta(session.infoHash, {
        title: req.body?.title ?? session.name,
        posterUrl: req.body?.posterUrl ?? null,
        imdbId: req.body?.imdbId ?? null,
        resolution: req.body?.resolution ?? null,
        videoCodec,
        startedAt: new Date().toISOString(),
      });
      return {
        infoHash: session.infoHash,
        videoName: session.videoName,
        videoLength: session.videoLength,
        streamUrl: `/stream/${session.infoHash}`,
        videoCodec,
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

  app.get<{ Params: { infoHash: string } }>(
    "/api/torrent/:infoHash/files",
    async (req, reply) => {
      const files = await listVideoFiles(req.params.infoHash);
      if (files.length === 0) {
        return reply.code(404).send({ error: "no video files" });
      }
      const m = getMeta(req.params.infoHash);
      return {
        files,
        selectedIndex: m?.selectedFileIndex ?? null,
      };
    },
  );

  app.post<{
    Params: { infoHash: string };
    Body: { index?: number };
  }>("/api/torrent/:infoHash/file", async (req, reply) => {
    const idx = req.body?.index;
    if (idx == null || !Number.isInteger(idx) || idx < 0) {
      return reply.code(400).send({
        error: "index (non-negative integer) required",
      });
    }
    try {
      const entry = await selectVideoFile(req.params.infoHash, idx);
      return { selected: entry };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "select failed";
      return reply.code(404).send({ error: msg });
    }
  });

  app.delete<{
    Params: { infoHash: string };
    Querystring: { destroy?: string };
  }>(
    "/api/torrent/:infoHash",
    async (req, reply) => {
      const destroyStore =
        req.query.destroy === "1" || req.query.destroy === "true";

      // Snapshot before removal — status/meta are gone once the torrent is.
      const status = await getStatus(req.params.infoHash);
      const m = getMeta(req.params.infoHash);

      // Cleanup runs FIRST and gets its own error surface. History bookkeeping
      // must never be able to strand the torrent — a failed history write used
      // to skip removeTorrent() entirely and leak the download forever.
      try {
        await removeTorrent(req.params.infoHash, { destroyStore });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "failed to remove";
        return reply.code(500).send({ error: msg });
      }

      if (status && m) {
        try {
          const endedAt = new Date().toISOString();
          if (m.historyId) {
            const ok = await updateHistoryById(m.historyId, {
              endedAt,
              completed: status.done,
            });
            if (!ok) {
              await appendHistory({
                id: randomUUID(),
                title: m.title,
                posterUrl: m.posterUrl,
                imdbId: m.imdbId,
                resolution: m.resolution,
                videoName: status.name,
                startedAt: m.startedAt,
                endedAt,
                completed: status.done,
              });
            }
          } else {
            await appendHistory({
              id: randomUUID(),
              title: m.title,
              posterUrl: m.posterUrl,
              imdbId: m.imdbId,
              resolution: m.resolution,
              videoName: status.name,
              startedAt: m.startedAt,
              endedAt,
              completed: status.done,
            });
          }
        } catch (err) {
          req.log.error(
            { err, infoHash: req.params.infoHash },
            "history write failed after torrent removal (torrent still cleaned up)",
          );
        }
      }

      return reply.code(204).send();
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

      const stream = range
        ? file.createReadStream({ start: range.start, end: range.end })
        : file.createReadStream();
      stream.on("error", (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE") return;
        req.log.warn({ err }, "file stream error");
      });

      // Wait for the first byte before responding so we can return 504
      // when WebTorrent has no peers and the bytes never arrive — instead
      // of letting the client hang on an open connection forever.
      try {
        await waitForFirstByte(stream, config.streamFirstByteTimeoutMs);
      } catch {
        try {
          stream.destroy();
        } catch {
          /* ignore */
        }
        return reply.code(504).send({
          error:
            "stream stalled — no bytes received within timeout. The torrent may have no peers.",
        });
      }

      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Type", contentType);

      if (range) {
        const { start, end } = range;
        reply.code(206);
        reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
        reply.header("Content-Length", String(end - start + 1));
        return reply.send(stream);
      }
      reply.header("Content-Length", String(size));
      return reply.send(stream);
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
      source.on("error", (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE") return;
        req.log.warn({ err }, "transcode source stream error");
      });
      const handle = spawnTranscode(source);
      handle.stdout.on("error", (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE") return;
        req.log.warn({ err }, "transcode stdout stream error");
      });

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

      // First-byte timeout: if ffmpeg never produces output (typically because
      // WebTorrent never delivered the source bytes), return 504 rather than
      // hanging the client. Once ffmpeg starts producing data the timeout
      // stops applying — mid-stream stalls are the client's problem.
      try {
        await waitForFirstByte(handle.stdout, config.streamFirstByteTimeoutMs);
      } catch {
        cleanup();
        return reply.code(504).send({
          error:
            "transcoded stream stalled — ffmpeg produced no output within timeout. The torrent may have no peers, or ffmpeg failed to start.",
        });
      }

      reply.header("Content-Type", "video/mp4");
      // Transcoded streams are not seekable in v1; range requests are ignored.
      reply.header("Accept-Ranges", "none");
      reply.header("Cache-Control", "no-store");
      return reply.send(handle.stdout);
    },
  );
}
