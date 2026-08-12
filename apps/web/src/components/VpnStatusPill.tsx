import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

interface Props {
  onOpenSettings: () => void;
}

/** Compact persistent-nav VPN status indicator. Polls `/api/system/vpn-health`
 *  every 60s via React Query. Clicking opens Settings and scrolls the VPN
 *  section into view. */
export function VpnStatusPill({ onOpenSettings }: Props) {
  const vpn = useQuery({
    queryKey: ["vpn-health"],
    queryFn: () => api.vpnHealth(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const h = vpn.data;

  let dotCls = "bg-zinc-500";
  let label = "…";
  let ariaState = "loading";
  let blink = false;

  if (h) {
    if (h.leaking) {
      dotCls = "bg-red-500";
      label = "LEAK";
      ariaState = "leaking";
      blink = true;
    } else if (h.mode === "vpn" && h.reachable) {
      dotCls = "bg-emerald-500";
      label = `VPN · ${h.country ?? "??"}`;
      ariaState = `healthy, exit country ${h.country ?? "unknown"}`;
    } else if (h.mode === "vpn" && !h.reachable) {
      dotCls = "bg-amber-500";
      label = "?";
      ariaState = "unreachable";
    } else if (h.mode === "off") {
      dotCls = "bg-zinc-500";
      label = "OFF";
      ariaState = "off";
    }
  }

  return (
    <button
      onClick={onOpenSettings}
      aria-label={`VPN status: ${ariaState}. Open VPN settings.`}
      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/70 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${dotCls} ${
          blink ? "animate-pulse" : ""
        }`}
        aria-hidden="true"
      />
      <span className="font-medium tracking-wide">{label}</span>
    </button>
  );
}
