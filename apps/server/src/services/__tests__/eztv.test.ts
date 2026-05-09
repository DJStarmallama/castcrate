import { describe, it, expect } from "vitest";
import { parseQuality, rank, toResult, type EztvTorrent } from "../eztv.js";

function torrent(overrides: Partial<EztvTorrent> = {}): EztvTorrent {
  // Defaults intentionally have NO quality markers so each test can set them
  // via filename or title without crosstalk from the other field.
  return {
    id: 1,
    hash: "abc",
    filename: "release.mkv",
    title: "Show S01E01",
    imdb_id: "11280740",
    season: "1",
    episode: "1",
    seeds: 50,
    peers: 5,
    size_bytes: "1500000000",
    torrent_url: "https://example.test/x.torrent",
    magnet_url: "magnet:?xt=urn:btih:abc",
    date_released_unix: 0,
    ...overrides,
  };
}

describe("parseQuality", () => {
  it("detects 1080p x264", () => {
    expect(parseQuality("Show.S01E01.1080p.WEB.x264-FOO.mkv", "")).toEqual({
      resolution: "1080p",
      videoCodec: "x264",
    });
  });

  it("detects 720p x265 / hevc / h.265", () => {
    expect(parseQuality("show.720p.x265.mkv", "")).toEqual({
      resolution: "720p",
      videoCodec: "x265",
    });
    expect(parseQuality("show.720p.HEVC.mkv", "")).toEqual({
      resolution: "720p",
      videoCodec: "x265",
    });
    expect(parseQuality("", "Show 720p H.265 EZTV")).toEqual({
      resolution: "720p",
      videoCodec: "x265",
    });
  });

  it("detects 2160p / 4k", () => {
    expect(parseQuality("show.2160p.mkv", "").resolution).toBe("2160p");
    expect(parseQuality("show.4k.HDR.mkv", "").resolution).toBe("2160p");
  });

  it("detects xvid", () => {
    expect(parseQuality("show.S01E01.XviD.AFG.avi", "").videoCodec).toBe("xvid");
  });

  it("returns unknown for missing markers", () => {
    expect(parseQuality("randomfile.mkv", "")).toEqual({
      resolution: "unknown",
      videoCodec: "unknown",
    });
  });

  it("falls back to title when filename is empty", () => {
    expect(parseQuality("", "Show S01 1080p WEBRip x264")).toEqual({
      resolution: "1080p",
      videoCodec: "x264",
    });
  });
});

describe("toResult", () => {
  it("converts season/episode strings to numbers", () => {
    const r = toResult(torrent({ season: "3", episode: "7" }));
    expect(r?.season).toBe(3);
    expect(r?.episode).toBe(7);
  });

  it("flags x264 as castFriendly", () => {
    const r = toResult(torrent({ filename: "show.1080p.x264.mkv" }));
    expect(r?.castFriendly).toBe(true);
  });

  it("flags x265 as not castFriendly", () => {
    const r = toResult(torrent({ filename: "show.1080p.x265.mkv" }));
    expect(r?.castFriendly).toBe(false);
  });

  it("drops xvid releases", () => {
    expect(toResult(torrent({ filename: "show.XviD.AFG.avi" }))).toBeNull();
  });

  it("drops magnet-less entries", () => {
    expect(toResult(torrent({ magnet_url: "" }))).toBeNull();
  });

  it("formats size in human units", () => {
    const r = toResult(torrent({ size_bytes: "2147483648" })); // 2 GiB
    expect(r?.size).toBe("2.0 GB");
  });
});

describe("rank", () => {
  it("castFriendly beats incompatible", () => {
    const a = toResult(torrent({ filename: "show.1080p.x264.mkv" }))!;
    const b = toResult(torrent({ filename: "show.1080p.x265.mkv" }))!;
    expect(rank(a, b)).toBeLessThan(0);
  });

  it("at same compat, 1080p beats 720p", () => {
    const a = toResult(torrent({ filename: "show.1080p.x264.mkv" }))!;
    const b = toResult(torrent({ filename: "show.720p.x264.mkv" }))!;
    expect(rank(a, b)).toBeLessThan(0);
  });

  it("at same compat+res, more seeds wins", () => {
    const a = toResult(torrent({ filename: "show.1080p.x264.mkv", seeds: 200 }))!;
    const b = toResult(torrent({ filename: "show.1080p.x264.mkv", seeds: 5 }))!;
    expect(rank(a, b)).toBeLessThan(0);
  });
});
