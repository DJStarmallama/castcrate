import dns, { resolve4, setServers } from "node:dns";

/**
 * Make Node's outbound DNS resolution use Cloudflare's public resolver
 * (1.1.1.1 / 1.0.0.1) instead of the OS resolver — but only for indexer
 * hostnames. Some networks NXDOMAIN well-known torrent indexer hostnames
 * at the resolver level even when the hosts themselves are reachable.
 *
 * Strategy: monkey-patch `dns.lookup` (the function `net`/`undici`/`fetch`
 * use). For hostnames matching the allowlist, try `dns.resolve4` against
 * the configured upstreams; otherwise (and on failure) fall through to the
 * original lookup so non-DNS problems (e.g. hostnames only in /etc/hosts)
 * still work.
 *
 * Configuration (env):
 *   DNS_BYPASS=false           — disable entirely
 *   DNS_UPSTREAMS=1.1.1.1,...  — public resolvers to query
 *   DNS_BYPASS_HOSTS=yts,eztv  — substring allowlist (default: yts,eztv,knaben)
 *   DNS_BYPASS_HOSTS=*         — bypass for every hostname (legacy global mode)
 */
export function setupDnsBypass(): boolean {
  if (process.env.DNS_BYPASS === "false") return false;

  const upstreams = (process.env.DNS_UPSTREAMS ?? "1.1.1.1,1.0.0.1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Default allowlist covers the indexers we ship today. Globs aren't needed —
  // a substring match handles `yts.bz`, `eztvx.to`, `api.knaben.org` cleanly.
  const hostsRaw = process.env.DNS_BYPASS_HOSTS ?? "yts,eztv,knaben";
  const wildcard = hostsRaw.trim() === "*";
  const allowlist = wildcard
    ? null
    : hostsRaw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

  setServers(upstreams);

  type LookupCallback = (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number,
  ) => void;
  type LookupAllCallback = (
    err: NodeJS.ErrnoException | null,
    addresses: { address: string; family: number }[],
  ) => void;
  type LookupOpts = { family?: number; hints?: number; all?: boolean } | undefined;

  const original = dns.lookup;

  const isIndexerHost = (hostname: string): boolean => {
    if (allowlist === null) return true; // wildcard
    const h = hostname.toLowerCase();
    return allowlist.some((p) => h.includes(p));
  };

  const patched = (
    hostname: string,
    optsOrCb: LookupOpts | LookupCallback | LookupAllCallback,
    maybeCb?: LookupCallback | LookupAllCallback,
  ) => {
    let opts: LookupOpts;
    let cb: LookupCallback | LookupAllCallback;
    if (typeof optsOrCb === "function") {
      cb = optsOrCb;
      opts = undefined;
    } else {
      opts = optsOrCb;
      cb = maybeCb!;
    }

    // Skip the bypass for non-indexer hosts (mDNS, OMDb, anything else) and
    // for IPv6 lookups (most indexers serve A records anyway).
    if (!isIndexerHost(hostname) || opts?.family === 6) {
      // @ts-expect-error overload
      return original(hostname, opts, cb);
    }

    resolve4(hostname, (err, addresses) => {
      if (err || !addresses?.length) {
        // Fall back to the OS resolver — keeps /etc/hosts and mDNS working.
        // @ts-expect-error overload
        return original(hostname, opts, cb);
      }
      if (opts?.all) {
        (cb as LookupAllCallback)(
          null,
          addresses.map((a) => ({ address: a, family: 4 })),
        );
      } else {
        (cb as LookupCallback)(null, addresses[0]!, 4);
      }
    });
  };

  // @ts-expect-error overloaded function
  dns.lookup = patched;
  return true;
}
