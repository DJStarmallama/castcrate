import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

interface Props {
  onClose: () => void;
}

export function Settings({ onClose }: Props) {
  const sys = useQuery({
    queryKey: ["system-check"],
    queryFn: () => api.systemCheck(),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-2xl font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-full bg-zinc-900 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mt-2 text-sm text-zinc-500">
          Configuration is read from <code className="text-zinc-300">.env</code>. Changes
          require a server restart.
        </p>

        {sys.isPending && <p className="mt-6 text-zinc-500">Loading…</p>}
        {sys.data && (
          <dl className="mt-6 space-y-4">
            <Row label="TMDB API key">
              {sys.data.tmdbConfigured ? (
                <span className="text-emerald-400">configured</span>
              ) : (
                <span className="text-amber-400">missing</span>
              )}
            </Row>
            <Row label="Download path">
              <code className="text-zinc-300">{sys.data.downloadPath}</code>
            </Row>
            <Row label="Buffer threshold">{sys.data.bufferPercent}%</Row>
          </dl>
        )}

        <div className="mt-8 border-t border-zinc-800 pt-6 text-xs text-zinc-500">
          <p className="font-medium text-zinc-400">Network notes</p>
          <ul className="mt-2 list-disc pl-4">
            <li>The server binds to <code>0.0.0.0:3000</code> so Chromecasts on the LAN can reach the stream.</li>
            <li>If torrent search fails with a DNS error, your network is blocking <code>yts.mx</code> — switch DNS, use a VPN, or set <code>YTS_BASE_URL</code>.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-sm text-zinc-400">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
