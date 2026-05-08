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
  tmdbApiKey: process.env.TMDB_API_KEY ?? "",
  downloadPath: expandTilde(process.env.DOWNLOAD_PATH ?? "~/Downloads/CastCrate"),
  bufferPercent: Number(process.env.BUFFER_PERCENT ?? 2),
};

export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
