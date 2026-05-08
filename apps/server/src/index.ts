import { config as loadEnv } from "dotenv";
import Fastify from "fastify";
import cors from "@fastify/cors";

loadEnv({ path: ["../../.env", ".env"], quiet: true });
const { config } = await import("./lib/config.js");
const { healthRoutes } = await import("./routes/health.js");
const { moviesRoutes } = await import("./routes/movies.js");
const { torrentRoutes } = await import("./routes/torrents.js");
const { castRoutes } = await import("./routes/cast.js");
const { historyRoutes } = await import("./routes/history.js");
const { shutdown } = await import("./services/torrent.js");
const { startDiscovery, stopDiscovery } = await import("./services/discovery.js");
const { shutdownCast } = await import("./services/cast.js");

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(healthRoutes);
await app.register(moviesRoutes);
await app.register(torrentRoutes);
await app.register(castRoutes);
await app.register(historyRoutes);

startDiscovery();

app.addHook("onClose", async () => {
  stopDiscovery();
  await shutdownCast();
  await shutdown();
});

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  // Bind to all interfaces so Chromecast on the LAN can fetch the stream.
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
