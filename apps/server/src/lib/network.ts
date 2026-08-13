import { networkInterfaces } from "node:os";
import { config } from "./config.js";

export function getLanIp(): string | null {
  // Env override — required inside a network namespace (vpn-split-tunnel),
  // where `os.networkInterfaces()` only sees `lo` + `veth-cc-ns`.
  if (config.castcrateLanIp) {
    return config.castcrateLanIp;
  }
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}
