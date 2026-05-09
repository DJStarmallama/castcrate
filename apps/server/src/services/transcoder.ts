import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { config } from "../lib/config.js";

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
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-b:v", config.transcodeBitrate,
    "-maxrate", config.transcodeBitrate,
    "-bufsize", `${parseBitrateMultiplier(config.transcodeBitrate, 2)}`,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ac", "2",
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
