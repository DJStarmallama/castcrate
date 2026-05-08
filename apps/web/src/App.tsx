import { useQuery } from "@tanstack/react-query";

interface PingResponse {
  ok: boolean;
  service: string;
  timestamp: string;
}

export default function App() {
  const ping = useQuery<PingResponse>({
    queryKey: ["ping"],
    queryFn: async () => {
      const r = await fetch("/api/ping");
      if (!r.ok) throw new Error(`ping failed: ${r.status}`);
      return r.json();
    },
  });

  return (
    <main className="flex min-h-full flex-col items-center justify-center p-8">
      <h1 className="text-7xl font-semibold tracking-tight">CastCrate</h1>
      <p className="mt-4 text-lg text-zinc-400">
        Search. Find. Cast.
      </p>
      <div className="mt-12 rounded-lg border border-zinc-800 bg-zinc-900 px-6 py-4 text-sm">
        <span className="text-zinc-500">server:</span>{" "}
        {ping.isPending && <span className="text-zinc-400">checking…</span>}
        {ping.isError && (
          <span className="text-red-400">unreachable ({ping.error.message})</span>
        )}
        {ping.data && (
          <span className="text-emerald-400">
            ok — {ping.data.service} @ {ping.data.timestamp}
          </span>
        )}
      </div>
    </main>
  );
}
