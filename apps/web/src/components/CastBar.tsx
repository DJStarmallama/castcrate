import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const devices = useQuery({
    queryKey: ["cast-devices"],
    queryFn: () => api.castDevices(),
    refetchInterval: 5000,
  });

  const playOn = useMutation({
    mutationFn: (device: CastDevice) =>
      api.castPlay({
        deviceId: device.id,
        streamPath,
        title,
        ...(posterUrl ? { posterUrl } : {}),
        ...(contentType ? { contentType } : {}),
        ...(subtitle && infoHash
          ? {
              subtitlePath: `/stream/${infoHash}/subtitles/${subtitle.index}`,
              subtitleLanguage: subtitle.language,
              subtitleName: subtitle.language,
            }
          : {}),
      }),
    onSuccess: (data) => {
      onSessionChange(data.sessionId);
      setOpen(false);
    },
  });

  const stopCast = useMutation({
    mutationFn: () => api.castControl(sessionId!, "stop"),
    onSettled: () => onSessionChange(null),
  });

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

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
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm hover:bg-zinc-800"
      >
        <CastIcon />
        Cast
        {list.length > 0 && (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs">{list.length}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-zinc-800 bg-zinc-950 p-2 shadow-xl">
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
            <p className="px-3 py-2 text-xs text-red-400">{playOn.error.message}</p>
          )}
        </div>
      )}
    </div>
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
