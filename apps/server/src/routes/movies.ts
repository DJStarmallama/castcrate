import type { FastifyInstance } from "fastify";
import { searchMovies, getMovieDetails, OmdbError } from "../services/omdb.js";

export async function moviesRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/api/search/movies", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return { results: [] };
    try {
      const results = await searchMovies(q);
      return { results };
    } catch (err) {
      if (err instanceof OmdbError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { imdbId: string } }>("/api/movies/:imdbId", async (req, reply) => {
    try {
      return await getMovieDetails(req.params.imdbId);
    } catch (err) {
      if (err instanceof OmdbError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });
}
