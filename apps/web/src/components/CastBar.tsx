import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import type { CastDevice } from "@castcrate/shared";
import { api, type SubtitleTrack } from "../lib/api";

interface Props {
  streamPath: string;
  title: string;
  posterUrl?: string | null;
  contentType?: string;
  onSessionChange: (sessionId: string | null) => void;
  sessionId: string | null;
  subtitle?: SubtitleTrack | null;
  infoHash?: string;
  /** IMDb id — forwarded to the server so the initial LOAD payload enumerates
   *  OpenSubtitles tracks alongside torrent-embedded ones. Without this the
   *  receiver won't know about any OS tracks and can't hot-swap to them. */
  imdbId?: string;
  /** When true, cast errors surface a "stream URL may have expired" message
   *  instead of the generic error text. Used for Stremio HTTP-stream sessions. */
  stremioHttpStream?: boolean;
}

/** URL suffix used to identify the initially-active subtitle on the server.
 *  Must match the shape the server builds in urlForSubtitle() so the
 *  `t.url.endsWith(subtitlePath)` check picks the right track. */
function subtitlePathFor(
  subtitle: SubtitleTrack,
  infoHash: string | undefined,
): string | null {
  if (subtitle.source === "torrent") {
    if (!infoHash) return null;
    return `/stream/${infoHash}/subtitles/${subtitle.index}`;
  }
  return `/api/subtitles/opensubtitles/${subtitle.fileId}`;
}

function subtitleLanguage(subtitle: SubtitleTrack): string {
  return subtitle.language;
}

function subtitleDisplayName(subtitle: SubtitleTrack): string {
  return subtitle.source === "torrent" ? subtitle.language : subtitle.languageName;
}

export function CastBar({
  streamPath,
  title,
  posterUrl,
  contentType,
  onSessionChange,
  sessionId,
  subtitle,
  infoHash,
  imdbId,
  stremioHttpStream = false,
}: Props) {
  const [open, setOpen] = useState(false);

  const devices = useQuery({
    queryKey: ["cast-devices"],
    queryFn: () => api.castDevices(),
    refetchInterval: 5000,
  });

  const playOn = useMutation({
    mutationFn: (device: CastDevice) => {
      const subtitleFields =
        subtitle && subtitlePathFor(subtitle, infoHash)
          ? {
              subtitlePath: subtitlePathFor(subtitle, infoHash)!,
              subtitleLanguage: subtitleLanguage(subtitle),
              subtitleName: subtitleDisplayName(subtitle),
            }
          : {};
      return api.castPlay({
        deviceId: device.id,
        streamPath,
        title,
        ...(posterUrl ? { posterUrl } : {}),
        ...(contentType ? { contentType } : {}),
        ...(imdbId ? { imdbId } : {}),
        ...subtitleFields,
      });
    },
    onSuccess: (data) => {
      onSessionChange(data.sessionId);
      setOpen(false);
    },
  });

  const stopCast = useMutation({
    mutationFn: () => api.castControl(sessionId!, "stop"),
    onSettled: () => onSessionChange(null),
  });

  if (sessionId) {
    return (
      <button
        onClick={() => stopCast.mutate()}
        className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400"
        disabled={stopCast.isPending}
      >
        {stopCast.isPending ? "Stopping…" : "Stop casting"}
      </button>
    );
  }

  const list = devices.data?.devices ?? [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm hover:bg-zinc-800">
          <CastIcon />
          Cast
          {list.length > 0 && (
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs">{list.length}</span>
          )}
        </button>
      </Popover.Trigger>
      {/*
        Portal target = #overlay-root (in index.html, outside the player's fixed
        z-50 wrapper). This is the load-bearing fix: without a portal, the
        dropdown gets composited under the <video> element on some browsers.
      */}
      <Popover.Portal container={typeof document !== "undefined" ? document.getElementById("overlay-root") : undefined}>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-[100] w-72 rounded-xl border border-zinc-800 bg-zinc-950 p-2 text-zinc-100 shadow-xl outline-none"
        >
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-zinc-500">
            Cast to device
          </div>
          {devices.isPending && (
            <p className="px-3 py-2 text-sm text-zinc-500">Discovering…</p>
          )}
          {!devices.isPending && list.length === 0 && (
            <p className="px-3 py-3 text-sm text-zinc-500">
              No Chromecasts found on this network.
            </p>
          )}
          {list.map((d) => (
            <button
              key={d.id}
              onClick={() => playOn.mutate(d)}
              disabled={playOn.isPending}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-900 disabled:opacity-50"
            >
              <CastIcon className="opacity-60" />
              <span className="flex-1 truncate">{d.name}</span>
              <span className="text-xs text-zinc-500">{d.ip}</span>
            </button>
          ))}
          {playOn.isError && (
            <p className="px-3 py-2 text-xs text-red-400">
              {stremioHttpStream
                ? "The stream URL may have expired or be unreachable. Search again to refresh."
                : playOn.error.message}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CastIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2 16.1A5 5 0 0 1 5.9 20" />
      <path d="M2 12.05A9 9 0 0 1 9.95 20" />
      <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      <line x1="2" y1="20" x2="2.01" y2="20" />
    </svg>
  );
}
