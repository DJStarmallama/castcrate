import type { FastifyInstance } from "fastify";
import { searchMovies, getMovieDetails, TmdbError } from "../services/tmdb.js";

export async function moviesRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/api/search/movies", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return { results: [] };
    try {
      const results = await searchMovies(q);
      return { results };
    } catch (err) {
      if (err instanceof TmdbError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { tmdbId: string } }>("/api/movies/:tmdbId", async (req, reply) => {
    const id = Number(req.params.tmdbId);
    if (!Number.isFinite(id)) {
      return reply.code(400).send({ error: "tmdbId must be a number" });
    }
    try {
      return await getMovieDetails(id);
    } catch (err) {
      if (err instanceof TmdbError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });
}
