import { config as loadEnv } from "dotenv";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

loadEnv({ path: ["../../.env", ".env"], quiet: true });
const { setupDnsBypass } = await import("./lib/dns.js");
setupDnsBypass();
const { config } = await import("./lib/config.js");
const { healthRoutes } = await import("./routes/health.js");
const { moviesRoutes } = await import("./routes/movies.js");
const { torrentRoutes } = await import("./routes/torrents.js");
const { castRoutes } = await import("./routes/cast.js");
const { historyRoutes } = await import("./routes/history.js");
const { subtitleRoutes } = await import("./routes/subtitles.js");
const { trailerRoutes } = await import("./routes/trailers.js");
const { discoverRoutes } = await import("./routes/discover.js");
const { proxyRoutes } = await import("./routes/proxy.js");
const { shutdown } = await import("./services/torrent.js");
const { startDiscovery, stopDiscovery } = await import("./services/discovery.js");
const { shutdownCast } = await import("./services/cast.js");
const { shutdownTranscodes } = await import("./services/transcoder.js");
const { initSettings } = await import("./services/settings.js");
await initSettings();
const fastifyWebsocket = (await import("@fastify/websocket")).default;
const { wsRoutes } = await import("./routes/ws.js");
const { startBroadcasters, stopBroadcasters } = await import(
  "./services/events.js"
);

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(fastifyWebsocket);
await app.register(wsRoutes);
await app.register(healthRoutes);
await app.register(moviesRoutes);
await app.register(torrentRoutes);
await app.register(castRoutes);
await app.register(historyRoutes);
await app.register(subtitleRoutes);
await app.register(trailerRoutes);
await app.register(discoverRoutes);
await app.register(proxyRoutes);

startBroadcasters();

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "../../web/dist");
if (existsSync(webDist)) {
  const { default: fastifyStatic } = await import("@fastify/static");
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/stream")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
  app.log.info(`Serving web bundle from ${webDist}`);
}

startDiscovery();

app.addHook("onClose", async () => {
  stopBroadcasters();
  stopDiscovery();
  await shutdownCast();
  await shutdownTranscodes();
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
