import { config as loadEnv } from "dotenv";
import Fastify from "fastify";
import cors from "@fastify/cors";

loadEnv({ path: ["../../.env", ".env"], quiet: true });
const { config } = await import("./lib/config.js");
const { healthRoutes } = await import("./routes/health.js");
const { moviesRoutes } = await import("./routes/movies.js");
const { torrentRoutes } = await import("./routes/torrents.js");
const { shutdown } = await import("./services/torrent.js");

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(healthRoutes);
await app.register(moviesRoutes);
await app.register(torrentRoutes);

app.addHook("onClose", async () => {
  await shutdown();
});

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  await app.listen({ port: config.port, host: "127.0.0.1" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
