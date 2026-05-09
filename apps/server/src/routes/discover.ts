import type { FastifyInstance } from "fastify";
import { getGenres, getPopularTitles } from "../services/justwatch.js";

// AU streaming providers we surface as Discover rows. Order = display order.
// shortNames come from JustWatch (`packages` query). Add/remove to taste.
const PROVIDERS = [
  { id: "nfx", name: "Netflix" },
  { id: "stn", name: "Stan" },
  { id: "bng", name: "BINGE" },
  { id: "prv", name: "Prime Video" },
  { id: "dnp", name: "Disney+" },
  { id: "pmp", name: "Paramount+" },
  { id: "atp", name: "Apple TV+" },
] as const;

const VALID_TYPES = new Set(["movie", "series"]);

export async function discoverRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      provider?: string;
      genre?: string;
      type?: string;
      limit?: string;
    };
  }>("/api/discover/popular", async (req, reply) => {
    const { provider, genre, type } = req.query;
    const limit = req.query.limit
      ? Math.min(50, Math.max(1, Number(req.query.limit)))
      : 18;
    const objectTypes =
      type === "movie"
        ? (["MOVIE"] as const)
        : type === "series"
          ? (["SHOW"] as const)
          : null;
    if (type && !VALID_TYPES.has(type)) {
      return reply.code(400).send({ error: "type must be 'movie' or 'series'" });
    }
    try {
      const titles = await getPopularTitles({
        country: "AU",
        first: limit,
        ...(provider ? { packages: [provider] } : {}),
        ...(genre ? { genres: [genre] } : {}),
        ...(objectTypes ? { objectTypes: [...objectTypes] } : {}),
      });
      return { titles };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "discover failed";
      return reply.code(502).send({ error: msg });
    }
  });

  app.get("/api/discover/genres", async (_req, reply) => {
    try {
      return { genres: await getGenres() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "genres failed";
      return reply.code(502).send({ error: msg });
    }
  });

  app.get("/api/discover/providers", async () => ({
    providers: PROVIDERS.map((p) => ({ ...p })),
  }));
}
