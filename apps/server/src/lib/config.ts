import { homedir } from "node:os";
import { resolve } from "node:path";

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(p.replace(/^~/, homedir()));
  }
  return resolve(p);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  omdbApiKey: process.env.OMDB_API_KEY ?? "",
  downloadPath: expandTilde(process.env.DOWNLOAD_PATH ?? "~/Downloads/LlamaSpitStream"),
  bufferPercent: Number(process.env.BUFFER_PERCENT ?? 2),
  transcodeBufferPercent: Number(process.env.TRANSCODE_BUFFER_PERCENT ?? 5),
  transcodeBitrate: process.env.TRANSCODE_BITRATE ?? "5M",
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ytsBaseUrl: process.env.YTS_BASE_URL ?? "https://movies-api.accel.li/api/v2",
  /** Optional SOCKS5/HTTP proxy URL loaded from env. Used as the default value
   *  for `proxyUrl` in runtime settings when no persisted value exists. */
  proxyUrl: process.env.PROXY_URL ?? null,
};
