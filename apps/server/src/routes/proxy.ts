import type { FastifyInstance } from "fastify";
import type { RequestInit as UndiciRequestInit } from "undici";
import { getDispatcher, type ProxyProvider } from "../lib/proxy.js";

const VALID_PROVIDERS = new Set<string>(["yts", "eztv", "knaben", "torrentday"]);

interface ProxyTestResult {
  ok: boolean;
  egressIp?: string;
  error?: string;
  elapsedMs: number;
}

export async function proxyRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { provider?: string } }>(
    "/api/proxy/test",
    async (req, reply): Promise<ProxyTestResult> => {
      const { provider } = req.query;

      if (!provider || !VALID_PROVIDERS.has(provider)) {
        return reply.code(400).send({
          ok: false,
          error: "provider must be one of: yts, eztv, knaben, torrentday",
          elapsedMs: 0,
        });
      }

      const dispatcher = getDispatcher(provider as ProxyProvider);

      if (!dispatcher) {
        return {
          ok: false,
          error: "proxy disabled for provider",
          elapsedMs: 0,
        };
      }

      const start = Date.now();
      try {
        const res = await fetch("https://api.ipify.org?format=json", {
          dispatcher,
          signal: AbortSignal.timeout(5000),
        } as UndiciRequestInit as unknown as RequestInit);

        const elapsedMs = Date.now() - start;

        if (!res.ok) {
          return { ok: false, error: `HTTP ${res.status}`, elapsedMs };
        }

        const data = (await res.json()) as { ip?: string };
        return { ok: true, egressIp: data.ip, elapsedMs };
      } catch (err) {
        const elapsedMs = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg, elapsedMs };
      }
    },
  );
}
