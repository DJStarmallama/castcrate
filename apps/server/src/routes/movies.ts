import type { FastifyInstance } from "fastify";
import {
  search,
  getMovieDetails,
  getSeriesDetails,
  getSeasonEpisodes,
  OmdbError,
} from "../services/omdb.js";

export async function moviesRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; type?: string } }>(
    "/api/search",
    async (req, reply) => {
      const q = (req.query.q ?? "").trim();
      if (!q) return { results: [] };
      const type =
        req.query.type === "movie" || req.query.type === "series"
          ? req.query.type
          : undefined;
      try {
        const results = await search(q, type);
        return { results };
      } catch (err) {
        if (err instanceof OmdbError) {
          return reply.code(err.status).send({ error: err.message });
        }
        throw err;
      }
    },
  );

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

  app.get<{ Params: { imdbId: string } }>("/api/series/:imdbId", async (req, reply) => {
    try {
      return await getSeriesDetails(req.params.imdbId);
    } catch (err) {
      if (err instanceof OmdbError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { imdbId: string; season: string } }>(
    "/api/series/:imdbId/seasons/:season",
    async (req, reply) => {
      const season = Number(req.params.season);
      try {
        const episodes = await getSeasonEpisodes(req.params.imdbId, season);
        return { season, episodes };
      } catch (err) {
        if (err instanceof OmdbError) {
          return reply.code(err.status).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
