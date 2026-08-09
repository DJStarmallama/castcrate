import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { api, type SubtitleTrack } from "../lib/api";

interface Props {
  infoHash: string;
  /** IMDb id — enables the OpenSubtitles fallback branch on the list endpoint.
   *  When omitted, only torrent-embedded tracks are surfaced. */
  imdbId?: string;
  selected: SubtitleTrack | null;
  onSelect: (track: SubtitleTrack | null) => void;
  /** When set, subtitle changes are also pushed to the Chromecast receiver
   *  via EDIT_TRACKS_INFO — no reload, no playback interruption. */
  castSessionId?: string | null;
}

// TrackId namespaces shared with the server (see OS_TRACK_ID_BASE and
// trackIdForSubtitle in apps/server/src/routes/cast.ts):
//   Torrent-embedded → `index + 1` (1..)
//   OpenSubtitles    → `10_000 + offset` where offset is the OS-array
//                       position (must match the order the picker rendered
//                       them in, which is the same order the server used at
//                       cast-start time; see `osOffset` below).
const OS_TRACK_ID_BASE = 10_000;

function torrentTrackId(track: Extract<SubtitleTrack, { source: "torrent" }>): number {
  return track.index + 1;
}
function opensubtitlesTrackId(osOffset: number): number {
  return OS_TRACK_ID_BASE + osOffset;
}

export function SubtitlePicker({
  infoHash,
  imdbId,
  selected,
  onSelect,
  castSessionId,
}: Props) {
  const [open, setOpen] = useState(false);

  const tracks = useQuery({
    queryKey: ["subtitle-tracks", infoHash, imdbId ?? null],
    queryFn: () => api.subtitleTracks(infoHash, imdbId),
    // Tracks become available after torrent metadata loads; poll briefly.
    // OpenSubtitles results arrive on the first hit — no need to poll for
    // those. If we already have any tracks, stop polling.
    refetchInterval: (q) => ((q.state.data?.tracks.length ?? 0) > 0 ? false : 3000),
  });

  const list = tracks.data?.tracks ?? [];
  const torrentTracks = useMemo(
    () => list.filter((t): t is Extract<SubtitleTrack, { source: "torrent" }> => t.source === "torrent"),
    [list],
  );
  const osTracks = useMemo(
    () => list.filter((t): t is Extract<SubtitleTrack, { source: "opensubtitles" }> => t.source === "opensubtitles"),
    [list],
  );

  // Map from track → server-visible trackId. OS tracks use their offset
  // position in `osTracks` (0-based) so the picker's rendering order matches
  // the server's numbering at cast-start time.
  const trackIdFor = (t: SubtitleTrack): number[] => {
    if (t.source === "torrent") return [torrentTrackId(t)];
    const idx = osTracks.findIndex((x) => x.id === t.id);
    if (idx === -1) return []; // shouldn't happen; safety net
    return [opensubtitlesTrackId(idx)];
  };

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
    if (castSessionId) swap.mutate(track ? trackIdFor(track) : []);
    setOpen(false);
  };

  const isSelected = (t: SubtitleTrack): boolean => {
    if (!selected) return false;
    if (selected.source !== t.source) return false;
    if (selected.source === "torrent" && t.source === "torrent") {
      return selected.index === t.index;
    }
    if (selected.source === "opensubtitles" && t.source === "opensubtitles") {
      return selected.id === t.id;
    }
    return false;
  };

  const selectedLabel = selected
    ? selected.source === "torrent"
      ? selected.language
      : selected.languageName
    : "CC";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className={`flex h-10 items-center gap-2 rounded-full px-3 text-sm transition ${
            selected
              ? "bg-emerald-500/15 text-emerald-200"
              : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
          }`}
          title={selected ? `Subtitles: ${selectedLabel}` : "Subtitles off"}
          aria-label="Subtitles"
        >
          <CcIcon />
          <span className="hidden md:inline">{selectedLabel}</span>
        </button>
      </Popover.Trigger>
      {/* Portal to #overlay-root — see CastBar for rationale. */}
      <Popover.Portal
        container={
          typeof document !== "undefined"
            ? document.getElementById("overlay-root")
            : undefined
        }
      >
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-[100] w-72 max-h-[70vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-2 text-zinc-100 shadow-xl outline-none"
        >
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-zinc-500">
            Subtitles
          </div>
          {tracks.isPending && (
            <p className="px-3 py-2 text-sm text-zinc-500">Looking for tracks…</p>
          )}
          {!tracks.isPending && list.length === 0 && (
            <p className="px-3 py-3 text-sm text-zinc-500">
              No subtitles found.
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
          {torrentTracks.length > 0 && (
            <>
              <div className="mt-2 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                In this torrent
              </div>
              {torrentTracks.map((t) => (
                <button
                  key={`torrent-${t.index}`}
                  onClick={() => handleSelect(t)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-900 ${
                    isSelected(t) ? "text-zinc-100" : "text-zinc-400"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{t.language}</span>
                  {isSelected(t) && (
                    <span className="text-emerald-400">✓</span>
                  )}
                </button>
              ))}
            </>
          )}
          {osTracks.length > 0 && (
            <>
              <div className="mt-2 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                OpenSubtitles
              </div>
              {osTracks.map((t) => (
                <button
                  key={`os-${t.id}`}
                  onClick={() => handleSelect(t)}
                  className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-900 ${
                    isSelected(t) ? "text-zinc-100" : "text-zinc-400"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{t.languageName}</div>
                    {(t.releaseName || typeof t.downloadCount === "number") && (
                      <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                        {t.releaseName ?? ""}
                        {t.releaseName && typeof t.downloadCount === "number"
                          ? " · "
                          : ""}
                        {typeof t.downloadCount === "number"
                          ? `${formatDownloadCount(t.downloadCount)} dl`
                          : ""}
                      </div>
                    )}
                  </div>
                  {isSelected(t) && (
                    <span className="mt-1 text-emerald-400">✓</span>
                  )}
                </button>
              ))}
            </>
          )}
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

/** Compact form for the download count in the picker: 1234 → "1.2k", 9500000 → "9.5M". */
function formatDownloadCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function CcIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19 4H5a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3zm-9 10.4a2.4 2.4 0 1 1 0-4.8 2.4 2.4 0 0 1 1.7.7l-.7.7a1.4 1.4 0 1 0 0 2 1.4 1.4 0 0 0 .8.4l-.4.9a2.4 2.4 0 0 1-1.4.1zm6 0a2.4 2.4 0 1 1 0-4.8 2.4 2.4 0 0 1 1.7.7l-.7.7a1.4 1.4 0 1 0 0 2 1.4 1.4 0 0 0 .8.4l-.4.9a2.4 2.4 0 0 1-1.4.1z" />
    </svg>
  );
}
