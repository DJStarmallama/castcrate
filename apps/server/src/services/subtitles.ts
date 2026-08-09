import { extname, basename } from "node:path";
import type { SubtitleTrack, TorrentSubtitleTrack, OpenSubtitlesSubtitleTrack } from "@castcrate/shared";
import { getTorrent } from "./torrent.js";
import { srtToVtt } from "../lib/srt.js";
import { searchOpenSubtitles, readOpenSubtitleContents } from "./opensubtitles.js";

// Re-export the shared type so callers importing from this module keep working.
export type { SubtitleTrack };

const SUB_EXTS = new Set([".srt", ".vtt"]);

const ISO_TO_LANG: Record<string, string> = {
  en: "English", eng: "English", english: "English",
  es: "Spanish", spa: "Spanish", spanish: "Spanish",
  fr: "French", fre: "French", french: "French", fra: "French",
  de: "German", ger: "German", german: "German", deu: "German",
  it: "Italian", ita: "Italian", italian: "Italian",
  pt: "Portuguese", por: "Portuguese", portuguese: "Portuguese",
  nl: "Dutch", dut: "Dutch", dutch: "Dutch", nld: "Dutch",
  ru: "Russian", rus: "Russian", russian: "Russian",
  ja: "Japanese", jpn: "Japanese", japanese: "Japanese",
  zh: "Chinese", chi: "Chinese", chinese: "Chinese", zho: "Chinese",
  ko: "Korean", kor: "Korean", korean: "Korean",
  ar: "Arabic", ara: "Arabic", arabic: "Arabic",
  pl: "Polish", pol: "Polish", polish: "Polish",
  tr: "Turkish", tur: "Turkish", turkish: "Turkish",
  sv: "Swedish", swe: "Swedish", swedish: "Swedish",
  da: "Danish", dan: "Danish", danish: "Danish",
  no: "Norwegian", nor: "Norwegian", norwegian: "Norwegian",
  fi: "Finnish", fin: "Finnish", finnish: "Finnish",
};

/**
 * Guess language from a subtitle filename.
 *  - "Movie.en.srt"      → English
 *  - "Movie.eng.srt"     → English
 *  - "Subs/Spanish.srt"  → Spanish
 *  - "Movie.srt"         → "Subtitles"
 */
function guessLanguage(filePath: string): string {
  const base = basename(filePath, extname(filePath)).toLowerCase();
  // Whole-name match: "english.srt" or "spanish.srt"
  if (ISO_TO_LANG[base]) return ISO_TO_LANG[base]!;
  // Trailing token after a dot or hyphen: "Movie.eng.srt", "Movie-en-forced.srt"
  const tokens = base.split(/[.\-_\s]+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (ISO_TO_LANG[t]) return ISO_TO_LANG[t]!;
  }
  return "Subtitles";
}

interface TorrentFileLike {
  name: string;
  path?: string;
  length: number;
  createReadStream(): NodeJS.ReadableStream;
}

interface TorrentLike {
  files: TorrentFileLike[];
}

function listFromTorrent(t: TorrentLike): TorrentSubtitleTrack[] {
  const tracks: TorrentSubtitleTrack[] = [];
  let idx = 0;
  for (const f of t.files) {
    const ext = extname(f.name).toLowerCase() as "" | ".srt" | ".vtt";
    if (!SUB_EXTS.has(ext)) continue;
    tracks.push({
      source: "torrent",
      index: idx++,
      fileName: f.path ?? f.name,
      language: guessLanguage(f.path ?? f.name),
      ext: ext as ".srt" | ".vtt",
    });
  }
  return tracks;
}

interface ListSubtitlesOpts {
  /** IMDb id ("tt1375666") — enables OpenSubtitles fallback. When omitted or
   *  when OpenSubtitles is disabled, only torrent-embedded tracks are returned. */
  imdbId?: string;
  /** Title fallback for OpenSubtitles when no imdbId is available. */
  query?: string;
}

/**
 * Discover subtitle tracks for a torrent. Returns torrent-embedded tracks first
 * (sorted by their file order), followed by OpenSubtitles tracks when an
 * `imdbId` is provided AND OpenSubtitles is configured.
 *
 * Never throws — subtitle discovery is best-effort. Failures in the OS branch
 * log and return an empty list so torrent-embedded tracks still surface.
 */
export async function listSubtitles(
  infoHash: string,
  opts: ListSubtitlesOpts = {},
): Promise<SubtitleTrack[]> {
  const t = (await getTorrent(infoHash)) as TorrentLike | null;
  const torrentTracks: TorrentSubtitleTrack[] = t ? listFromTorrent(t) : [];

  const osTracks: OpenSubtitlesSubtitleTrack[] = [];
  if (opts.imdbId || opts.query) {
    const searchOpts: Parameters<typeof searchOpenSubtitles>[0] = {};
    if (opts.imdbId) searchOpts.imdbId = opts.imdbId;
    if (opts.query) searchOpts.query = opts.query;
    const os = await searchOpenSubtitles(searchOpts);
    for (const track of os) {
      const entry: OpenSubtitlesSubtitleTrack = {
        source: "opensubtitles",
        id: track.id,
        fileId: track.fileId,
        language: track.language,
        languageName: track.languageName,
      };
      if (track.releaseName) entry.releaseName = track.releaseName;
      if (typeof track.downloadCount === "number") {
        entry.downloadCount = track.downloadCount;
      }
      osTracks.push(entry);
    }
  }

  return [...torrentTracks, ...osTracks];
}

export async function readSubtitleVtt(
  infoHash: string,
  index: number,
): Promise<string | null> {
  const t = (await getTorrent(infoHash)) as TorrentLike | null;
  if (!t) return null;
  const tracks = listFromTorrent(t);
  const track = tracks[index];
  if (!track) return null;
  // Find the matching file
  const file = t.files.find((f) => (f.path ?? f.name) === track.fileName);
  if (!file) return null;
  // Prioritize the subtitle file so the bytes are fetched quickly
  const f = file as TorrentFileLike & { select?: (priority?: number) => void };
  f.select?.(1);
  const text = await streamToString(file.createReadStream());
  return track.ext === ".vtt" ? text : srtToVtt(text);
}

/** Read + convert an OpenSubtitles-sourced SRT to VTT. The disk cache in
 *  services/opensubtitles.ts guarantees the SRT is fetched at most once per
 *  file_id — subsequent calls are pure fs reads + VTT conversion. */
export async function readOpenSubtitleVtt(id: string): Promise<string> {
  const srt = await readOpenSubtitleContents(id);
  return srtToVtt(srt);
}

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

export const _internals = { listFromTorrent, guessLanguage };
