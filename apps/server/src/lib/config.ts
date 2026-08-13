import { homedir } from "node:os";
import { resolve } from "node:path";
import type { VpnMode } from "@castcrate/shared";

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
  /** How long to wait for the first byte from WebTorrent (or ffmpeg) before
   *  returning 504. Once bytes start flowing this timeout stops applying —
   *  mid-stream stalls are the client's problem. */
  streamFirstByteTimeoutMs: Number(process.env.STREAM_FIRST_BYTE_TIMEOUT_MS ?? 60_000),
  /** Optional SOCKS5/HTTP proxy URL loaded from env. Used as the default value
   *  for `proxyUrl` in runtime settings when no persisted value exists. */
  proxyUrl: process.env.PROXY_URL ?? null,
  /** Override for `getLanIp()`. When set (non-empty), skips `os.networkInterfaces()`
   *  auto-detect and returns this value directly. Needed for netns'd deploys
   *  (vpn-split-tunnel) where inside the ns only `lo` + `veth-cc-ns` are visible
   *  and auto-detect would return `10.200.200.2` — unreachable from LAN and
   *  breaking Chromecast stream URL construction. Leave unset on macOS dev. */
  castcrateLanIp: process.env.CASTCRATE_LAN_IP ?? null,
  /** VPN routing mode. Accepts three literal values; anything else — including
   *  unset — collapses to `"off"` (macOS dev / opt-out).
   *
   *  - `"vpn"` — full-tunnel (v1, `vpn-split-tunnel`): Fastify runs inside
   *    `castcrate-ns`; all outbound egress via WG.
   *  - `"torrentday-only"` — split (v2, `vpn-torrentday-only`): Fastify on host
   *    for full peer throughput; only TorrentDay HTTP fetches are spawned into
   *    the ns via `ip netns exec castcrate-ns node td-fetcher.js <url>`.
   *  - `"off"` — no VPN routing; short-circuits `/api/system/vpn-health`.
   *
   *  The parser matches exact literals only — no aliases (no `"td-only"`,
   *  no case-insensitive match). Value must appear verbatim in the env. */
  vpnMode: ((): VpnMode => {
    const raw = process.env.VPN_MODE ?? "off";
    return raw === "vpn" || raw === "torrentday-only" ? raw : "off";
  })(),
  /** Host's clearnet public IP captured BEFORE enabling the netns. Used by
   *  `/api/system/vpn-health` to detect leaks (`publicIp === hostClearnetIp`
   *  → `leaking: true`). Env-only in v1 per Decision D5 — the runbook
   *  instructs the user to `curl ifconfig.co/ip` and paste the result.
   *  When null, leak detection is disabled (returns `leaking: false`) rather
   *  than false-positive. */
  hostClearnetIp: process.env.HOST_CLEARNET_IP ?? null,
  /** OpenSubtitles REST API v1 key. Free tier available at
   *  https://www.opensubtitles.com/en/consumers. When unset the OpenSubtitles
   *  fallback is disabled (subtitle discovery returns torrent-embedded only). */
  openSubtitlesApiKey: process.env.OPENSUBTITLES_API_KEY ?? "",
  /** Comma-separated ISO 639 language codes to restrict OpenSubtitles results
   *  to. Defaults to `["en"]`. Whitespace around commas is tolerated. */
  openSubtitlesLanguages: (process.env.OPENSUBTITLES_LANGUAGES ?? "en")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** Max concurrent background downloads spawned by the Watch Later queue.
   *  Kept low by default because the 2011 MBP deploy box has 8 GB RAM and
   *  shares WebTorrent capacity with any active cast-now stream. Increase if
   *  the box gains headroom. See watch-later feature — Key Decisions #3. */
  maxConcurrentQueued: Number(process.env.MAX_CONCURRENT_QUEUED ?? 2),
};
