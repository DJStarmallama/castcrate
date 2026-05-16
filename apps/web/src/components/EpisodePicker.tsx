import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SeriesDetails, SeriesEpisode, TorrentResult } from "@castcrate/shared";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { useEscape } from "../hooks/useEscape";

interface Props {
  series: SeriesDetails;
  episode: SeriesEpisode;
  onClose: () => void;
  onPick: (torrent: TorrentResult) => void;
}

export function EpisodePicker({ series, episode, onClose, onPick }: Props) {
  useEscape(onClose);
  const [tab, setTab] = useState<"episode" | "season">("episode");

  const q = useQuery({
    queryKey: ["episode-torrents", series.imdbId, episode.season, episode.episode],
    queryFn: () =>
      api.searchEpisodeTorrents(
        series.imdbId,
        episode.season,
        episode.episode,
        series.title,
      ),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full bg-zinc-900/80 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Close"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <h2 className="text-xl font-semibold">Find sources</h2>
        <p className="text-sm text-zinc-500">
          {series.title} · S{episode.season}E{String(episode.episode).padStart(2, "0")}
          {episode.title && ` — ${episode.title}`}
        </p>

        <div className="mt-4 flex gap-1 border-b border-zinc-800">
          <TabButton active={tab === "episode"} onClick={() => setTab("episode")}>
            Episode
            {q.data && (
              <span className="ml-2 rounded-full bg-zinc-800 px-2 text-xs">
                {q.data.episode.length}
              </span>
            )}
          </TabButton>
          <TabButton active={tab === "season"} onClick={() => setTab("season")}>
            Season pack
            {q.data && (
              <span className="ml-2 rounded-full bg-zinc-800 px-2 text-xs">
                {q.data.seasonPacks.length}
              </span>
            )}
          </TabButton>
        </div>

        <div className="mt-4">
          {q.isPending && <p className="text-zinc-500">Searching torrents…</p>}
          {q.isError && (
            <EmptyResults
              tried={extractTried(q.error.message)}
              error={q.error.message}
            />
          )}
          {q.data && tab === "episode" && (
            q.data.episode.length === 0 ? (
              <EmptyResults tried={q.data.tried ?? []} />
            ) : (
              <TorrentList results={q.data.episode} onPick={onPick} />
            )
          )}
          {q.data && tab === "season" && (
            q.data.seasonPacks.length === 0 ? (
              <EmptyResults tried={q.data.tried ?? []} kind="season" />
            ) : (
              <TorrentList results={q.data.seasonPacks} onPick={onPick} />
            )
          )}
        </div>
      </div>
    </div>
  );
}

function extractTried(msg: string): string[] {
  const tried: string[] = [];
  if (/\beztv\b/i.test(msg)) tried.push("eztv");
  if (/\bknaben\b/i.test(msg)) tried.push("knaben");
  return tried;
}

function EmptyResults({
  tried,
  error,
  kind = "episode",
}: {
  tried: string[];
  error?: string;
  kind?: "episode" | "season";
}) {
  const triedLabel = tried.length === 0 ? "" : tried.join(", ");
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-sm text-zinc-400">
      <p>
        No {kind === "season" ? "season packs" : "episode torrents"} found
        {triedLabel ? ` in ${triedLabel}` : ""}.
      </p>
      <ul className="mt-3 list-disc pl-5 text-xs text-zinc-500">
        <li>Older or niche shows often aren't indexed by EZTV or Knaben.</li>
        <li>
          Adding a private tracker (or using a tool like Prowlarr) would expand
          coverage. Public indexers tend to focus on currently airing content.
        </li>
        <li>
          If you're on a restrictive network, indexer hosts may be blocked at the
          DNS level — a VPN usually fixes this.
        </li>
      </ul>
      {error && (
        <p className="mt-3 text-xs text-red-400/80">debug: {error}</p>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
        active
          ? "border-zinc-100 text-zinc-100"
          : "border-transparent text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

function TorrentList({
  results,
  onPick,
}: {
  results: TorrentResult[];
  onPick: (t: TorrentResult) => void;
}) {
  if (results.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
        No torrents found.
      </p>
    );
  }
  const top = results[0]!;
  const rest = results.slice(1);
  return (
    <div className="space-y-2">
      <TorrentRow torrent={top} highlight onPick={() => onPick(top)} />
      {rest.map((t, i) => (
        <TorrentRow key={`${t.magnet}-${i}`} torrent={t} onPick={() => onPick(t)} />
      ))}
    </div>
  );
}

function TorrentRow({
  torrent,
  highlight,
  onPick,
}: {
  torrent: TorrentResult;
  highlight?: boolean;
  onPick: () => void;
}) {
  const isStremio = torrent.source === "stremio";
  const isInstant = isStremio && Boolean(torrent.streamUrl);
  const sizeText = torrent.sizeBytes > 0 ? formatBytes(torrent.sizeBytes) : "size unknown";
  const swarmText = isStremio
    ? `via ${torrent.addonOrigin ?? "Stremio"} · seeds unknown`
    : `${torrent.seeds} seeds · ${torrent.peers} peers`;
  return (
    <button
      onClick={onPick}
      className={`flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition ${
        isInstant
          ? "border-amber-500/40 bg-amber-950/10 hover:border-amber-400/60"
          : highlight
            ? "border-emerald-700/40 bg-emerald-950/20 hover:border-emerald-500/60"
            : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-900"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>{torrent.resolution}</span>
          <span className="text-zinc-500">·</span>
          <span>{torrent.videoCodec}</span>
          {isInstant && (
            <span
              className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300"
              title="Real-Debrid cached — plays instantly, no peer wait"
            >
              ⚡ Instant
            </span>
          )}
          {!torrent.castFriendly && (
            <span
              className="rounded-full bg-amber-900/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-300"
              title="HEVC may not play on older Chromecasts (transcoding is a v2 feature)"
            >
              compat?
            </span>
          )}
        </div>
        <div className="text-xs text-zinc-500">
          {sizeText} · {swarmText}
        </div>
        <div className="truncate text-xs text-zinc-600">{torrent.title}</div>
      </div>
      <span
        className={`ml-3 flex-shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
          isInstant
            ? "bg-amber-500 text-black"
            : highlight
              ? "bg-emerald-500 text-black"
              : "bg-zinc-800 text-zinc-300"
        }`}
      >
        Cast
      </span>
    </button>
  );
}
