import type { FastifyInstance } from "fastify";
import { rmdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AddToQueueRequest,
  LibraryPlayResponse,
} from "@castcrate/shared";
import {
  addToQueue,
  findById,
  listLibrary,
  remove,
  setPinned,
} from "../services/library.js";
import { kickDownloadQueue } from "../services/download-queue.js";
import { removeTorrent } from "../services/torrent.js";

export async function libraryRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /api/library/queue — add a title to the Watch Later queue.
  //
  // Body: { magnet, metadata: { title, year, poster, imdbId, source } }
  // Idempotent by magnet + hash (see library.ts addToQueue). Kicks the queue
  // processor after add so the download starts within a scheduler tick
  // rather than waiting on the 30s poll.
  // -------------------------------------------------------------------------
  app.post<{ Body: AddToQueueRequest }>(
    "/api/library/queue",
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: "body required" });
      }
      const { magnet, metadata } = body;
      if (typeof magnet !== "string" || !magnet.startsWith("magnet:")) {
        return reply
          .code(400)
          .send({ error: "magnet is required and must start with 'magnet:'" });
      }
      if (!metadata || typeof metadata !== "object") {
        return reply.code(400).send({ error: "metadata is required" });
      }
      if (typeof metadata.title !== "string" || metadata.title.trim() === "") {
        return reply.code(400).send({ error: "metadata.title is required" });
      }
      if (typeof metadata.source !== "string") {
        return reply.code(400).send({ error: "metadata.source is required" });
      }
      const result = await addToQueue({ magnet, metadata });
      // Wake the worker — non-blocking. If already running, no-op.
      kickDownloadQueue();
      return result;
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/library — three sections, pre-sorted addedAt desc.
  // -------------------------------------------------------------------------
  app.get("/api/library", async () => listLibrary());

  // -------------------------------------------------------------------------
  // DELETE /api/library/:id — remove manifest entry + delete on-disk files.
  //
  // Semantics:
  // - Item not found → 404.
  // - Item still active in WebTorrent (has hash but not detached) → tear
  //   down via removeTorrent(hash, destroyStore=true) which handles both
  //   client detach + disk cleanup.
  // - Otherwise, if filePath is set, unlink the file directly and best-effort
  //   rmdir the enclosing directory (empty-dir sweep matches the prune script).
  // - Idempotent-friendly: file-already-gone errors are swallowed. Manifest
  //   removal is authoritative.
  //
  // NOTE: Unlike the plan's original 409-on-pinned guard, pin does NOT block
  // deletion here — the UI is responsible for confirmation. The pin flag's
  // sole promise is that the RETENTION PRUNE won't touch the file; explicit
  // user delete is still allowed. See watch-later Key Decision #7 rationale
  // and the frontend agent's UI contract.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/api/library/:id",
    async (req, reply) => {
      const item = await findById(req.params.id);
      if (!item) return reply.code(404).send({ error: "not found" });

      // Detach + destroy store when the torrent is still known to the client.
      // removeTorrent is idempotent (swallows "No torrent with id …") so
      // calling it against an already-detached hash is safe.
      if (item.hash) {
        try {
          await removeTorrent(item.hash, { destroyStore: true });
        } catch (err) {
          req.log.warn(
            { err, id: item.id, hash: item.hash },
            "removeTorrent failed during DELETE /api/library/:id (continuing with file/manifest cleanup)",
          );
        }
      }

      // Delete the on-disk file if we recorded one at completion. Best-effort
      // rmdir sweeps the enclosing directory when empty (matches the prune
      // script's post-delete empty-dir sweep).
      if (item.filePath) {
        try {
          await unlink(item.filePath);
        } catch (err) {
          // ENOENT is fine (file already gone via destroyStore above, or
          // pruned externally). Anything else, log and continue — manifest
          // authority wins.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            req.log.warn(
              { err, id: item.id, filePath: item.filePath },
              "unlink failed during DELETE /api/library/:id (continuing)",
            );
          }
        }
        try {
          await rmdir(dirname(item.filePath));
        } catch {
          // Not empty, not a directory, ENOENT — all fine.
        }
      }

      await remove(item.id);
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/library/:id/pin — set the pinned flag.
  //
  // Body: { pinned: boolean }. Returns 204 on success, 404 when the id is
  // unknown, 400 when the body is malformed.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: { pinned?: boolean } }>(
    "/api/library/:id/pin",
    async (req, reply) => {
      const body = req.body;
      if (
        !body ||
        typeof body !== "object" ||
        typeof body.pinned !== "boolean"
      ) {
        return reply
          .code(400)
          .send({ error: "body.pinned (boolean) is required" });
      }
      const item = await findById(req.params.id);
      if (!item) return reply.code(404).send({ error: "not found" });
      await setPinned(item.id, body.pinned);
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/library/:id/play — return the stream URL for a completed item.
  //
  // Semantics:
  // - Item must be completed (completedAt !== null && hash !== null).
  // - The stream URL points at /stream/:hash — the same endpoint the cast-now
  //   flow uses. Because the pieces are already on disk, WebTorrent reports
  //   done: true immediately, so byte-range reads are instant.
  //
  // The client is responsible for POSTing /api/torrent/start if the torrent
  // is not currently attached (server-restart case). Kept simple here: this
  // endpoint returns URLs, not lifecycle. The torrent route already handles
  // duplicate-add gracefully.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/api/library/:id/play",
    async (req, reply) => {
      const item = await findById(req.params.id);
      if (!item) return reply.code(404).send({ error: "not found" });
      if (item.completedAt === null || item.hash === null) {
        return reply.code(409).send({ error: "not ready to play" });
      }
      const response: LibraryPlayResponse = {
        streamUrl: `/stream/${item.hash}`,
        hash: item.hash,
      };
      return response;
    },
  );
}
