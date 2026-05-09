import { describe, it, expect } from "vitest";
import {
  buildMagnet,
  rank,
  rankAndFilter,
  toResult,
  type YtsMovie,
  type YtsTorrent,
} from "../yts.js";

function torrent(overrides: Partial<YtsTorrent> = {}): YtsTorrent {
  return {
    url: "https://example.test/x.torrent",
    hash: "1234567890abcdef1234567890abcdef12345678",
    quality: "1080p",
    type: "bluray",
    seeds: 100,
    peers: 10,
    size: "2.0 GB",
    size_bytes: 2_000_000_000,
    video_codec: "x264",
    audio_channels: "5.1",
    ...overrides,
  };
}

function movie(torrents: YtsTorrent[], year = 2010): YtsMovie {
  return {
    id: 1,
    title: "Inception",
    title_long: `Inception (${year})`,
    year,
    large_cover_image: null,
    torrents,
  };
}

describe("buildMagnet", () => {
  it("constructs a magnet with hash, name, and trackers", () => {
    const m = buildMagnet("abcd1234", "Some Title");
    expect(m).toMatch(/^magnet:\?xt=urn:btih:abcd1234/);
    expect(m).toContain("dn=Some%20Title");
    expect(m).toContain("tr=udp%3A%2F%2Fopen.demonii.com");
  });
});

describe("toResult", () => {
  it("accepts 1080p x264", () => {
    const r = toResult(torrent({ quality: "1080p", video_codec: "x264" }), movie([]));
    expect(r).not.toBeNull();
    expect(r?.resolution).toBe("1080p");
  });

  it("accepts 720p h264", () => {
    const r = toResult(torrent({ quality: "720p", video_codec: "h264" }), movie([]));
    expect(r?.resolution).toBe("720p");
  });

  it("rejects 2160p", () => {
    expect(toResult(torrent({ quality: "2160p" }), movie([]))).toBeNull();
  });

  it("rejects x265 / HEVC", () => {
    expect(toResult(torrent({ video_codec: "x265" }), movie([]))).toBeNull();
    expect(toResult(torrent({ video_codec: "HEVC" }), movie([]))).toBeNull();
  });

  it("includes seeds, peers, size in the result", () => {
    const r = toResult(
      torrent({ seeds: 42, peers: 7, size: "1.4 GB", size_bytes: 1_400_000_000 }),
      movie([]),
    );
    expect(r).toMatchObject({
      seeds: 42,
      peers: 7,
      size: "1.4 GB",
      sizeBytes: 1_400_000_000,
      source: "yts",
    });
  });
});

describe("rank", () => {
  it("prefers 1080p over 720p", () => {
    const t1080 = toResult(torrent({ quality: "1080p" }), movie([]))!;
    const t720 = toResult(torrent({ quality: "720p" }), movie([]))!;
    expect(rank(t1080, t720)).toBeLessThan(0);
    expect(rank(t720, t1080)).toBeGreaterThan(0);
  });

  it("at the same quality, prefers more seeds", () => {
    const a = toResult(torrent({ quality: "1080p", seeds: 200 }), movie([]))!;
    const b = toResult(torrent({ quality: "1080p", seeds: 50 }), movie([]))!;
    expect(rank(a, b)).toBeLessThan(0);
  });
});

describe("rankAndFilter", () => {
  it("filters incompatible torrents and sorts by quality then seeds", () => {
    const m = movie([
      torrent({ quality: "2160p", seeds: 999 }),
      torrent({ quality: "720p", seeds: 50, video_codec: "x264" }),
      torrent({ quality: "1080p", seeds: 10, video_codec: "x265" }),
      torrent({ quality: "1080p", seeds: 30, video_codec: "x264" }),
      torrent({ quality: "1080p", seeds: 200, video_codec: "x264" }),
    ]);
    const out = rankAndFilter([m]);
    expect(out.length).toBe(3);
    expect(out[0]).toMatchObject({ resolution: "1080p", seeds: 200 });
    expect(out[1]).toMatchObject({ resolution: "1080p", seeds: 30 });
    expect(out[2]).toMatchObject({ resolution: "720p" });
  });
});
