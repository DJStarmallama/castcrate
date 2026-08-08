import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { api, type SubtitleTrack } from "../lib/api";

interface Props {
  infoHash: string;
  selected: SubtitleTrack | null;
  onSelect: (track: SubtitleTrack | null) => void;
}

export function SubtitlePicker({ infoHash, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);

  const tracks = useQuery({
    queryKey: ["subtitle-tracks", infoHash],
    queryFn: () => api.subtitleTracks(infoHash),
    // Tracks become available after torrent metadata loads; poll briefly.
    refetchInterval: (q) => ((q.state.data?.tracks.length ?? 0) > 0 ? false : 3000),
  });

  const list = tracks.data?.tracks ?? [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className={`flex h-10 items-center gap-2 rounded-full px-3 text-sm transition ${
            selected
              ? "bg-emerald-500/15 text-emerald-200"
              : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
          }`}
          title={selected ? `Subtitles: ${selected.language}` : "Subtitles off"}
          aria-label="Subtitles"
        >
          <CcIcon />
          <span className="hidden md:inline">
            {selected ? selected.language : "CC"}
          </span>
        </button>
      </Popover.Trigger>
      {/* Portal to #overlay-root — see CastBar for rationale. */}
      <Popover.Portal container={typeof document !== "undefined" ? document.getElementById("overlay-root") : undefined}>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-[100] w-64 rounded-xl border border-zinc-800 bg-zinc-950 p-2 text-zinc-100 shadow-xl outline-none"
        >
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-zinc-500">
            Subtitles
          </div>
          {tracks.isPending && (
            <p className="px-3 py-2 text-sm text-zinc-500">Looking for tracks…</p>
          )}
          {!tracks.isPending && list.length === 0 && (
            <p className="px-3 py-3 text-sm text-zinc-500">
              No subtitles in this torrent.
            </p>
          )}
          {list.length > 0 && (
            <button
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-900 ${
                !selected ? "text-zinc-100" : "text-zinc-400"
              }`}
            >
              Off {!selected && <span className="text-emerald-400">✓</span>}
            </button>
          )}
          {list.map((t) => (
            <button
              key={t.index}
              onClick={() => {
                onSelect(t);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-900 ${
                selected?.index === t.index ? "text-zinc-100" : "text-zinc-400"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{t.language}</span>
              {selected?.index === t.index && (
                <span className="text-emerald-400">✓</span>
              )}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CcIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19 4H5a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3zm-9 10.4a2.4 2.4 0 1 1 0-4.8 2.4 2.4 0 0 1 1.7.7l-.7.7a1.4 1.4 0 1 0 0 2 1.4 1.4 0 0 0 .8.4l-.4.9a2.4 2.4 0 0 1-1.4.1zm6 0a2.4 2.4 0 1 1 0-4.8 2.4 2.4 0 0 1 1.7.7l-.7.7a1.4 1.4 0 1 0 0 2 1.4 1.4 0 0 0 .8.4l-.4.9a2.4 2.4 0 0 1-1.4.1z" />
    </svg>
  );
}
