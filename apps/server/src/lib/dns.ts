import dns, { resolve4, setServers } from "node:dns";

/**
 * Make Node's outbound DNS resolution use Cloudflare's public resolver
 * (1.1.1.1 / 1.0.0.1) instead of the OS resolver. Some networks NXDOMAIN
 * well-known torrent indexer hostnames at the resolver level even when
 * the hosts themselves are reachable.
 *
 * Strategy: monkey-patch `dns.lookup` (the function `net`/`undici`/`fetch`
 * use) to first try `dns.resolve4` against the configured upstreams. If
 * that yields no answer, fall through to the original lookup so non-DNS
 * problems (e.g., hostnames only in /etc/hosts) still work.
 *
 * Set DNS_BYPASS=false in .env to disable.
 */
export function setupDnsBypass(): boolean {
  if (process.env.DNS_BYPASS === "false") return false;

  const upstreams = (process.env.DNS_UPSTREAMS ?? "1.1.1.1,1.0.0.1")
    .split(",")
    .map((s) => s.trim())
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

    // IPv6 lookups: pass through. We only redirect IPv4 (most indexers
    // serve A records anyway).
    if (opts?.family === 6) {
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
