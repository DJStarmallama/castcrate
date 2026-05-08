import { Bonjour, type Service } from "bonjour-service";
import type { CastDevice } from "@castcrate/shared";

let bonjourInstance: Bonjour | null = null;
const devices = new Map<string, CastDevice>();
const listeners = new Set<(devices: CastDevice[]) => void>();

function emit() {
  const list = [...devices.values()];
  for (const cb of listeners) cb(list);
}

function deviceFromService(svc: Service): CastDevice | null {
  const ip =
    svc.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? svc.referer?.address;
  if (!ip) return null;
  const friendly =
    (svc.txt as Record<string, string> | undefined)?.fn ?? svc.name ?? "Chromecast";
  const id = (svc.txt as Record<string, string> | undefined)?.id ?? svc.fqdn ?? svc.name;
  if (!id) return null;
  return { id, name: friendly, ip, port: svc.port };
}

export function startDiscovery(): void {
  if (bonjourInstance) return;
  bonjourInstance = new Bonjour();
  const browser = bonjourInstance.find({ type: "googlecast" });
  browser.on("up", (svc) => {
    const d = deviceFromService(svc);
    if (d) {
      devices.set(d.id, d);
      emit();
    }
  });
  browser.on("down", (svc) => {
    const d = deviceFromService(svc);
    if (d && devices.delete(d.id)) emit();
  });
}

export function listDevices(): CastDevice[] {
  return [...devices.values()];
}

export function onDevicesChanged(cb: (devices: CastDevice[]) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function stopDiscovery(): void {
  if (bonjourInstance) {
    bonjourInstance.destroy();
    bonjourInstance = null;
  }
  devices.clear();
}
