import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { config } from "../lib/config.js";
import { checkFfmpeg } from "../services/transcoder.js";
import {
  getSettings,
  updateSettings,
  type RuntimeSettings,
} from "../services/settings.js";
import { getVpnHealth } from "../services/vpn-health.js";
import { maskStremioUrl } from "./stremio.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/api/ping", async () => ({
    ok: true,
    service: "llama-spit-stream-server",
    timestamp: new Date().toISOString(),
  }));

  app.get<{ Querystring: { refresh?: string } }>(
    "/api/system/check",
    async (req) => {
      // ?refresh=1 forces a fresh ffmpeg probe — useful after the user installs
      // it without restarting the server.
      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const ff = await checkFfmpeg(refresh);
      const s = getSettings();
      return {
        ok: true,
        omdbConfigured: Boolean(config.omdbApiKey),
        downloadPath: config.downloadPath,
        bufferPercent: s.bufferPercent,
        transcodeBufferPercent: s.transcodeBufferPercent,
        transcodeBitrate: s.transcodeBitrate,
        ffmpeg: ff,
      };
    },
  );

  app.get<{ Querystring: { refresh?: string } }>(
    "/api/system/vpn-health",
    async (req) => {
      // Any truthy `?refresh=...` bypasses the 30s cache. No auth — matches
      // `/api/system/check` (both are read-only status endpoints).
      const q = req.query.refresh;
      const forceRefresh = q !== undefined && q !== "" && q !== "0" && q !== "false";
      return getVpnHealth(forceRefresh);
    },
  );

  app.get("/api/settings", async () => {
    const s = getSettings();
    // Mask sensitive credentials — server-internal values only.
    return {
      ...s,
      torrentDay: {
        enabled: s.torrentDay.enabled,
        uid: s.torrentDay.uid !== null ? "***" : null,
        pass: s.torrentDay.pass !== null ? "***" : null,
      },
      // Stremio addon URLs may contain personalised secrets (e.g. Real-Debrid
      // API keys in the path). Expose the host only so users can identify addons.
      stremioAddons: s.stremioAddons.map((a) => ({
        ...a,
        url: maskStremioUrl(a.url),
      })),
      // VPN surface — presence-only. Never returns WG keys, endpoint, or the
      // config file contents. `vpnConfigured` is a boot-time-cheap `existsSync`
      // call; no in-memory cache needed per Phase 4 spec.
      vpnMode: config.vpnMode,
      vpnConfigured: existsSync("/etc/castcrate/wg0.conf"),
    };
  });

  app.patch<{ Body: Partial<RuntimeSettings> }>(
    "/api/settings",
    async (req) => {
      const updated = await updateSettings(req.body ?? {});
      // Mask sensitive credentials in the response.
      return {
        ...updated,
        torrentDay: {
          enabled: updated.torrentDay.enabled,
          uid: updated.torrentDay.uid !== null ? "***" : null,
          pass: updated.torrentDay.pass !== null ? "***" : null,
        },
        stremioAddons: updated.stremioAddons.map((a) => ({
          ...a,
          url: maskStremioUrl(a.url),
        })),
      };
    },
  );
}
