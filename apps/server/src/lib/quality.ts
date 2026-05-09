import type { TorrentResult } from "@castcrate/shared";

export interface ParsedQuality {
  resolution: TorrentResult["resolution"];
  videoCodec: string;
}

const RES_PATTERNS: { re: RegExp; res: TorrentResult["resolution"] }[] = [
  { re: /\b2160p\b|\b4k\b/i, res: "2160p" },
  { re: /\b1080p\b/i, res: "1080p" },
  { re: /\b720p\b/i, res: "720p" },
  { re: /\b480p\b/i, res: "480p" },
];

const CODEC_PATTERNS: { re: RegExp; codec: string }[] = [
  { re: /\b(x265|h\.?265|hevc)\b/i, codec: "x265" },
  { re: /\b(x264|h\.?264)\b/i, codec: "x264" },
  { re: /\bxvid\b/i, codec: "xvid" },
  { re: /\bav1\b/i, codec: "av1" },
];

export function parseQuality(...needles: string[]): ParsedQuality {
  const haystack = needles.filter(Boolean).join(" ");
  let resolution: TorrentResult["resolution"] = "unknown";
  for (const p of RES_PATTERNS) {
    if (p.re.test(haystack)) {
      resolution = p.res;
      break;
    }
  }
  let videoCodec = "unknown";
  for (const c of CODEC_PATTERNS) {
    if (c.re.test(haystack)) {
      videoCodec = c.codec;
      break;
    }
  }
  return { resolution, videoCodec };
}

export function isCastFriendly(q: ParsedQuality): boolean {
  return q.videoCodec === "x264";
}

export function rankResolution(r: TorrentResult["resolution"]): number {
  if (r === "1080p") return 4;
  if (r === "720p") return 3;
  if (r === "2160p") return 2;
  if (r === "480p") return 1;
  return 0;
}

export function rankCodec(c: string): number {
  if (c === "x264") return 4;
  if (c === "unknown") return 3;
  if (c === "x265") return 2;
  if (c === "av1") return 1;
  return 0;
}

export function rankTorrent(a: TorrentResult, b: TorrentResult): number {
  const cf = Number(b.castFriendly) - Number(a.castFriendly);
  if (cf !== 0) return cf;
  const rs = rankResolution(b.resolution) - rankResolution(a.resolution);
  if (rs !== 0) return rs;
  const cd = rankCodec(b.videoCodec) - rankCodec(a.videoCodec);
  if (cd !== 0) return cd;
  return b.seeds - a.seeds;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
