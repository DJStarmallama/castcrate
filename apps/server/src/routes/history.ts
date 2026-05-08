import type { FastifyInstance } from "fastify";
import { listHistory, clearHistory } from "../services/history.js";

export async function historyRoutes(app: FastifyInstance) {
  app.get("/api/history", async () => ({ entries: await listHistory() }));

  app.delete("/api/history", async (_req, reply) => {
    await clearHistory();
    return reply.code(204).send();
  });
}
