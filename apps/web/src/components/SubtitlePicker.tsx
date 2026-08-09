import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { api, type SubtitleTrack } from "../lib/api";

interface Props {
  infoHash: string;
  selected: SubtitleTrack | null;
  onSelect: (track: SubtitleTrack | null) => void;
  /** When set, subtitle changes are also pushed to the Chromecast receiver
   *  via EDIT_TRACKS_INFO — no reload, no playback interruption. */
  castSessionId?: string | null;
  /**
   * Optional controlled open state. When provided, the parent owns the flag
   * — used by PlayerControls so the bar's auto-hide can pause while the
   * menu is open, and so the "C" keyboard shortcut can imperatively open it.
   * Without these, the picker keeps its internal open state.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

// trackId convention shared with the server: subtitle.index + 1 (see
// PlayTrack.trackId in apps/server/src/services/cast.ts). 0-based indexes
// are shifted so that trackId 0 — which some Chromecast firmware treats as
// "no active track" — is never used for a real subtitle.
function trackIdFor(track: SubtitleTrack | null): number[] {
  return track ? [track.index + 1] : [];
}

export function SubtitlePicker({
  infoHash,
  selected,
  onSelect,
  castSessionId,
  open: controlledOpen,
  onOpenChange,
}: Props) {
  // Controlled/uncontrolled hybrid: if the parent passed `open`, they own it;
  // otherwise we keep local state. Matches Radix's Popover.Root controlled API.
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const tracks = useQuery({
    queryKey: ["subtitle-tracks", infoHash],
    queryFn: () => api.subtitleTracks(infoHash),
    // Tracks become available after torrent metadata loads; poll briefly.
    refetchInterval: (q) => ((q.state.data?.tracks.length ?? 0) > 0 ? false : 3000),
  });

  // When casting, mirror the local selection to the receiver. We keep the
  // local state update (Player still renders <track> if the browser tab is
  // visible during cast); the mutation only handles the receiver side.
  //
  // Fire-and-forget: we surface errors as a small warning inside the popover
  // but don't roll back the local selection — the user can retry by picking
  // the same track again.
  const swap = useMutation({
    mutationFn: (activeTrackIds: number[]) =>
      api.setCastActiveTracks(castSessionId!, activeTrackIds),
  });

  const handleSelect = (track: SubtitleTrack | null) => {
    onSelect(track);
    if (castSessionId) swap.mutate(trackIdFor(track));
    setOpen(false);
  };

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
              onClick={() => handleSelect(null)}
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
              onClick={() => handleSelect(t)}
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
          {swap.isError && (
            <p className="px-3 py-2 text-xs text-red-400">
              Couldn't update the Chromecast — try again.
            </p>
          )}
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
