import { config as loadEnv } from "dotenv";
import Fastify from "fastify";
import cors from "@fastify/cors";

loadEnv({ path: ["../../.env", ".env"], quiet: true });
const { config } = await import("./lib/config.js");
const { healthRoutes } = await import("./routes/health.js");
const { moviesRoutes } = await import("./routes/movies.js");

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(healthRoutes);
await app.register(moviesRoutes);

try {
  await app.listen({ port: config.port, host: "127.0.0.1" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
