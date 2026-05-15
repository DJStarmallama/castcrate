/**
 * lib/proxy.ts
 *
 * Returns an undici Dispatcher (or undefined for direct routing) for a given
 * provider. The dispatcher is selected based on the current runtime settings:
 *   - proxyUrl must be set
 *   - proxyEnabled[provider] must be true
 *
 * SOCKS5 approach:
 *   We use socks-proxy-agent to open the proxied socket, then wrap it inside
 *   an undici Agent via the `connect` option (a buildConnector.connector
 *   function). This keeps a single global fetch() implementation — no
 *   node-fetch fallback. socks5h:// uses remote DNS; socks5:// uses local DNS.
 *
 * HTTP/HTTPS proxies use undici.ProxyAgent directly.
 */

import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type buildConnector from "undici/types/connector.js";
import { SocksProxyAgent } from "socks-proxy-agent";
import * as net from "node:net";
import * as http from "node:http";
import { getSettings, onSettingsUpdate } from "../services/settings.js";

export type ProxyProvider = "yts" | "eztv" | "knaben" | "torrentday";

// ---------------------------------------------------------------------------
// Cache — keyed by "<url>::<provider>" so each provider slot is independent.
// Invalidated when settings change.
// ---------------------------------------------------------------------------

const dispatcherCache = new Map<string, Dispatcher>();

export function resetProxyCache(): void {
  // Destroy existing dispatchers gracefully before evicting.
  for (const [, d] of dispatcherCache) {
    try {
      void (d as Dispatcher & { destroy?: () => void }).destroy?.();
    } catch {
      // ignore — best-effort cleanup
    }
  }
  dispatcherCache.clear();
}

// Wire cache invalidation into the settings update lifecycle.
onSettingsUpdate(resetProxyCache);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a configured undici Dispatcher when the given provider should route
 * via the proxy, or `undefined` when the provider should use the direct route.
 *
 * A Dispatcher is returned only when:
 *   1. `proxyUrl` is a non-null, non-empty string, AND
 *   2. `proxyEnabled[provider]` is true.
 */
export function getDispatcher(provider: ProxyProvider): Dispatcher | undefined {
  const settings = getSettings();
  const { proxyUrl, proxyEnabled } = settings;

  if (!proxyUrl || !proxyEnabled[provider]) return undefined;

  const cacheKey = `${proxyUrl}::${provider}`;
  const cached = dispatcherCache.get(cacheKey);
  if (cached) return cached;

  const dispatcher = buildDispatcher(proxyUrl);
  dispatcherCache.set(cacheKey, dispatcher);
  return dispatcher;
}

/**
 * Masks the userinfo segment of a proxy URL so it is safe to log.
 *
 * Examples:
 *   socks5h://user:pass@host:1080  →  socks5h://****@host:1080
 *   http://proxy.example.com:8080  →  http://proxy.example.com:8080
 *   socks5://host:1080             →  socks5://host:1080
 */
export function redactProxyUrl(url: string): string {
  try {
    const schemeMatch = /^(socks5h?|http|https):\/\//.exec(url);
    if (!schemeMatch) return url;

    const scheme = schemeMatch[1]!;
    // Swap to http:// so URL() can parse it, then reconstruct.
    const parseable = "http://" + url.slice(schemeMatch[0].length);
    const parsed = new URL(parseable);

    if (!parsed.username && !parsed.password) return url;

    const hostPort = parsed.host; // includes port if present
    const path = parsed.pathname + parsed.search + parsed.hash;
    return `${scheme}://****@${hostPort}${path === "/" ? "" : path}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Internal — dispatcher factory
// ---------------------------------------------------------------------------

function buildDispatcher(proxyUrl: string): Dispatcher {
  if (proxyUrl.startsWith("socks5://") || proxyUrl.startsWith("socks5h://")) {
    return buildSocksDispatcher(proxyUrl);
  }
  // http:// or https:// → use undici ProxyAgent directly.
  return new ProxyAgent(proxyUrl);
}

/**
 * Builds an undici Agent whose `connect` callback opens each TCP connection
 * via the SOCKS5 proxy. This keeps us in undici's native fetch path and
 * respects remote DNS (socks5h://) vs local DNS (socks5://).
 *
 * The SocksProxyAgent.connect() method is async and returns a net.Socket.
 * We adapt it to undici's synchronous connector callback interface by calling
 * the async path and forwarding the result / error to the callback.
 */
function buildSocksDispatcher(proxyUrl: string): Dispatcher {
  const socksAgent = new SocksProxyAgent(proxyUrl);

  const connector: buildConnector.connector = (
    opts: buildConnector.Options,
    callback: buildConnector.Callback,
  ) => {
    // Build a minimal ClientRequest stub that SocksProxyAgent.connect() reads.
    const port = Number(opts.port);
    const isSecure = opts.protocol === "https:";

    // SocksProxyAgent needs these fields from a ClientRequest.
    const reqStub = Object.assign(Object.create(http.ClientRequest.prototype), {
      host: opts.hostname ?? opts.host ?? "",
      // For socks-proxy-agent the port in AgentConnectOpts is what matters.
    }) as http.ClientRequest;

    const agentOpts = {
      host: opts.hostname ?? opts.host ?? "",
      port,
      secureEndpoint: isSecure,
      // These are part of AgentConnectOpts from agent-base:
      protocol: opts.protocol,
      pathname: "/",
      search: "",
    } as Parameters<typeof socksAgent.connect>[1];

    socksAgent
      .connect(reqStub, agentOpts)
      .then((socket: net.Socket) => {
        callback(null, socket);
      })
      .catch((err: Error) => {
        callback(err, null);
      });
  };

  return new Agent({ connect: connector });
}
