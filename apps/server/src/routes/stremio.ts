import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getSettings, updateSettings } from "../services/settings.js";
import { validateAddon, normaliseAddonBase, searchStremioMovie } from "../services/stremio.js";

// ---------------------------------------------------------------------------
// URL masking helper — exported for unit tests.
// ---------------------------------------------------------------------------

/**
 * Masks the path component of a Stremio addon URL so that personalised secrets
 * (e.g. Real-Debrid API keys embedded in the path) are not exposed to the UI.
 *
 * The host is preserved so users can identify which addon is which.
 *
 * Examples:
 *   https://torrentio.strem.fun/debridoptions=RD|apiKey=abc123 → https://torrentio.strem.fun/****
 *   https://example.com  (no path or bare "/")                 → https://example.com
 *   <malformed>                                                 → ****
 */
export function maskStremioUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // pathname is "/" when there is no meaningful path — nothing to mask.
    if (parsed.pathname === "" || parsed.pathname === "/") {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return `${parsed.protocol}//${parsed.host}/****`;
  } catch {
    return "****";
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function stremioRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /api/stremio/addons — validate manifest, generate id, append to list.
  // -------------------------------------------------------------------------
  app.post<{ Body: { url?: unknown } }>(
    "/api/stremio/addons",
    async (req, reply) => {
      const rawUrl = req.body?.url;

      if (typeof rawUrl !== "string" || !/^https?:\/\/.+/.test(rawUrl.trim())) {
        return reply.code(400).send({ error: "url must be http(s)://..." });
      }

      const result = await validateAddon(rawUrl.trim());
      if (!result.ok) {
        return reply.code(400).send({ error: result.error });
      }

      const normalisedUrl = normaliseAddonBase(rawUrl.trim());
      const existing = getSettings().stremioAddons;

      if (existing.some((a) => a.url === normalisedUrl)) {
        return reply.code(409).send({ error: "addon already added" });
      }

      // Log the host only — the path may contain personalised secrets.
      try {
        const host = new URL(normalisedUrl).host;
        app.log.info(`stremio: adding addon host=${host}`);
      } catch {
        // Ignore malformed URL — validateAddon already passed.
      }

      const id = randomUUID().slice(0, 8);
      const newEntry = {
        id,
        url: normalisedUrl,
        name: result.manifest!.name,
        enabled: true,
      };

      await updateSettings({ stremioAddons: [...existing, newEntry] });

      const response: { addon: typeof newEntry; warning?: string } = { addon: newEntry };
      if (result.warning !== undefined) {
        response.warning = result.warning;
      }
      return reply.code(201).send(response);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/stremio/addons/:id — remove addon by id.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/api/stremio/addons/:id",
    async (req, reply) => {
      const { id } = req.params;
      const existing = getSettings().stremioAddons;
      const idx = existing.findIndex((a) => a.id === id);

      if (idx === -1) {
        return reply.code(404).send({ error: "addon not found" });
      }

      const filtered = existing.filter((a) => a.id !== id);
      await updateSettings({ stremioAddons: filtered });
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/stremio/test/:id — run Inception search through this addon only.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/api/stremio/test/:id",
    async (req, reply): Promise<{
      ok: boolean;
      sampleCount?: number;
      firstTitle?: string;
      hasStreamUrl?: boolean;
      error?: string;
    }> => {
      const { id } = req.params;
      const addon = getSettings().stremioAddons.find((a) => a.id === id);

      if (!addon) {
        return reply.code(404).send({ error: "addon not found" });
      }

      if (!addon.enabled) {
        return {
          ok: false,
          error: "addon is disabled — enable it before testing",
        };
      }

      // Pass this single addon as the override — bypasses getSettings() read
      // inside searchStremioMovie so only this addon is queried.
      const INCEPTION_IMDB = "tt1375666";
      const outcome = await searchStremioMovie(INCEPTION_IMDB, [addon]);

      if (outcome.errors.length > 0 && outcome.results.length === 0) {
        return {
          ok: false,
          error: outcome.errors[0]!.code,
        };
      }

      return {
        ok: true,
        sampleCount: outcome.results.length,
        firstTitle: outcome.results[0]?.title,
        hasStreamUrl: outcome.results.some((r) => Boolean(r.streamUrl)),
        ...(outcome.errors.length > 0 ? { error: outcome.errors[0]!.code } : {}),
      };
    },
  );
}
