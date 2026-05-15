import type { FastifyInstance } from "fastify";
import { searchTorrentDayMovie, TorrentDayAuthError, TorrentDayDisabledError } from "../services/torrentday.js";

export async function torrentdayRoutes(app: FastifyInstance) {
  app.get(
    "/api/torrentday/test",
    async (_req, reply): Promise<{ ok: boolean; sample?: string[]; error?: string }> => {
      try {
        const results = await Promise.race([
          searchTorrentDayMovie("big buck bunny"),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("test timed out")), 10_000),
          ),
        ]);
        const sample = results.slice(0, 3).map((r) => r.title);
        return { ok: true, sample };
      } catch (err) {
        if (err instanceof TorrentDayDisabledError) {
          return reply.code(503).send({
            ok: false,
            error: "TorrentDay is disabled or credentials are not configured",
          });
        }
        if (err instanceof TorrentDayAuthError) {
          return reply.code(401).send({
            ok: false,
            error: "TorrentDay auth failed — check your uid and pass cookies",
          });
        }
        const msg = err instanceof Error ? err.message : "unknown error";
        return reply.code(502).send({ ok: false, error: msg });
      }
    },
  );
}
