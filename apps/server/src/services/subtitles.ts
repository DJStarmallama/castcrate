import { extname, basename } from "node:path";
import { getTorrent } from "./torrent.js";
import { srtToVtt } from "../lib/srt.js";

export interface SubtitleTrack {
  index: number;
  fileName: string;
  language: string;
  ext: ".srt" | ".vtt";
}

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

function listFromTorrent(t: TorrentLike): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  let idx = 0;
  for (const f of t.files) {
    const ext = extname(f.name).toLowerCase() as "" | ".srt" | ".vtt";
    if (!SUB_EXTS.has(ext)) continue;
    tracks.push({
      index: idx++,
      fileName: f.path ?? f.name,
      language: guessLanguage(f.path ?? f.name),
      ext: ext as ".srt" | ".vtt",
    });
  }
  return tracks;
}

export async function listSubtitles(infoHash: string): Promise<SubtitleTrack[]> {
  const t = (await getTorrent(infoHash)) as TorrentLike | null;
  if (!t) return [];
  return listFromTorrent(t);
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
