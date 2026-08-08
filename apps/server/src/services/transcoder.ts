import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { config } from "../lib/config.js";
import { getSettings } from "./settings.js";

const execFileP = promisify(execFile);

export interface FfmpegInfo {
  available: boolean;
  version: string | null;
  path: string;
}

let ffmpegInfoCache: FfmpegInfo | null = null;

export async function checkFfmpeg(force = false): Promise<FfmpegInfo> {
  if (!force && ffmpegInfoCache) return ffmpegInfoCache;
  try {
    const { stdout } = await execFileP(config.ffmpegPath, ["-version"]);
    const firstLine = stdout.split("\n")[0] ?? "";
    const m = /ffmpeg version (\S+)/.exec(firstLine);
    ffmpegInfoCache = {
      available: true,
      version: m ? m[1]! : firstLine.trim(),
      path: config.ffmpegPath,
    };
  } catch {
    ffmpegInfoCache = { available: false, version: null, path: config.ffmpegPath };
  }
  return ffmpegInfoCache;
}

// Active subprocesses, so a server shutdown can cleanly terminate them
// instead of orphaning ffmpeg as zombie processes.
const activeProcesses = new Set<ChildProcessWithoutNullStreams>();

export interface TranscodeHandle {
  process: ChildProcessWithoutNullStreams;
  stdout: Readable;
}

/**
 * Spawn ffmpeg to transcode `source` (typically a torrent file's read stream)
 * to a fragmented MP4 capped at ~5 Mbps that the Default Media Receiver can
 * play directly. Caller is responsible for piping `stdout` to the HTTP response
 * and calling `process.kill()` on client disconnect.
 */
export function spawnTranscode(source: Readable): TranscodeHandle {
  // Read bitrate from runtime settings so the user can edit it live in the
  // Settings UI without restarting the server.
  const bitrate = getSettings().transcodeBitrate;
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-b:v", bitrate,
    "-maxrate", bitrate,
    "-bufsize", `${parseBitrateMultiplier(bitrate, 2)}`,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ac", "2",
    // Audio loudness chain, in order:
    //   1. acompressor — aggressive dynamic-range compression. threshold=-30dB
    //      + ratio=6:1 pulls quiet dialogue way up (blockbuster mixes assume
    //      theatrical monitoring, not a TV at "volume 20").
    //   2. loudnorm — EBU R128 target -10 LUFS integrated. This is HOT (TikTok
    //      territory; streaming platforms usually stop at -14). Justified for
    //      cast use: TV speakers benefit from broadcast-style loudness.
    //   3. alimiter — look-ahead limiter. Post-boost peaks get caught here at
    //      0.95 (just under 0dBFS) so the extra gain doesn't produce ugly
    //      digital clipping.
    // The combined effect is ~12-14dB louder perceived vs untreated x264 audio.
    // Past this point audio quality degrades noticeably (pumping, distortion) —
    // if this still isn't loud enough, the ceiling is Chromecast / TV output.
    "-af", "acompressor=threshold=-30dB:ratio=6:attack=3:release=80,loudnorm=I=-10:TP=-1.0:LRA=6,alimiter=limit=0.95:attack=5",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ];

  const process = spawn(config.ffmpegPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  activeProcesses.add(process);
  process.once("exit", () => activeProcesses.delete(process));

  // Pipe torrent bytes into ffmpeg, swallow EPIPE if ffmpeg exits early
  source.pipe(process.stdin).on("error", () => {});

  return { process, stdout: process.stdout };
}

/** Kill every live transcode subprocess. Wired to the Fastify onClose hook. */
export async function shutdownTranscodes(timeoutMs = 1500): Promise<void> {
  if (activeProcesses.size === 0) return;
  for (const p of activeProcesses) {
    if (!p.killed) p.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  for (const p of activeProcesses) {
    if (!p.killed) p.kill("SIGKILL");
  }
  activeProcesses.clear();
}

function parseBitrateMultiplier(rate: string, mul: number): string {
  // Accept formats like "5M", "4500k", "1500000"
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(rate);
  if (!m) return `${10 * 1024 * 1024}`; // 10M default
  const value = Number(m[1]) * mul;
  const suffix = (m[2] ?? "").toLowerCase();
  if (suffix === "m") return `${value}M`;
  if (suffix === "k") return `${value}k`;
  return `${value}`;
}
