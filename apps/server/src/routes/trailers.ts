import type { FastifyInstance } from "fastify";
import { findTrailerVideoId, trailerSearchUrl } from "../services/youtube.js";

export async function trailerRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { title?: string; year?: string } }>(
    "/api/trailer",
    async (req, reply) => {
      const title = (req.query.title ?? "").trim();
      if (!title) {
        return reply.code(400).send({ error: "title is required" });
      }
      const year = req.query.year ? Number(req.query.year) : undefined;
      const query = `${title}${year ? ` ${year}` : ""} official trailer`;
      const videoId = await findTrailerVideoId(query);
      // Always 200 so the client can render the search-link fallback when
      // we can't resolve a videoId without rolling an error path.
      return {
        videoId,
        embedUrl: videoId ? `https://www.youtube.com/embed/${videoId}` : null,
        searchUrl: trailerSearchUrl(query),
      };
    },
  );
}
