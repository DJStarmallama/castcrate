import { describe, it, expect } from "vitest";
import {
  _internals,
  episodeMatchesTitle,
  seasonPackMatchesTitle,
} from "../knaben.js";

const baseHit = {
  id: "abc",
  title: "Some.Show.S01E05.1080p.x264.WEB",
  bytes: 1_400_000_000,
  seeders: 42,
  peers: 5,
};

describe("episodeMatchesTitle", () => {
  it("matches S01E05", () => {
    expect(episodeMatchesTitle("Show.Name.S01E05.1080p.x264", 1, 5)).toBe(true);
  });

  it("matches lowercase s01e05", () => {
    expect(episodeMatchesTitle("show.s01e05.web", 1, 5)).toBe(true);
  });

  it("matches 1x05 alternative", () => {
    expect(episodeMatchesTitle("Show 1x05 Title", 1, 5)).toBe(true);
  });

  it("matches Season X Episode Y verbose form", () => {
    expect(episodeMatchesTitle("Show Season 1 Episode 5", 1, 5)).toBe(true);
  });

  it("does not match adjacent episodes", () => {
    expect(episodeMatchesTitle("Show.S01E04.1080p", 1, 5)).toBe(false);
    expect(episodeMatchesTitle("Show.S01E06.1080p", 1, 5)).toBe(false);
  });

  it("does not match same episode in another season", () => {
    expect(episodeMatchesTitle("Show.S02E05.1080p", 1, 5)).toBe(false);
  });

  it("does not false-positive on substrings", () => {
    expect(episodeMatchesTitle("Show.S01E50.1080p", 1, 5)).toBe(false);
  });

  it("matches non-zero-padded S/E forms (S1E5)", () => {
    expect(episodeMatchesTitle("Show.S1E5.DVDRip", 1, 5)).toBe(true);
    expect(episodeMatchesTitle("Show.1x5.WEB", 1, 5)).toBe(true);
  });
});

describe("seasonPackMatchesTitle", () => {
  it("matches Show.S01.COMPLETE", () => {
    expect(seasonPackMatchesTitle("Show.S01.COMPLETE.1080p.x264", 1)).toBe(true);
  });
  it("matches non-zero-padded S1", () => {
    expect(seasonPackMatchesTitle("Show.S1.PROPER", 1)).toBe(true);
  });
  it("matches Season 1 verbose form", () => {
    expect(seasonPackMatchesTitle("Show Season 1 1080p", 1)).toBe(true);
  });
  it("matches Season.1 dot form", () => {
    expect(seasonPackMatchesTitle("Show.Season.1.WEB", 1)).toBe(true);
  });
  it("rejects single-episode releases", () => {
    expect(seasonPackMatchesTitle("Show.S01E05.1080p", 1)).toBe(false);
    expect(seasonPackMatchesTitle("Show.S01.E05", 1)).toBe(false);
    expect(seasonPackMatchesTitle("Show.1x05.WEB", 1)).toBe(false);
  });
  it("rejects different season", () => {
    expect(seasonPackMatchesTitle("Show.S02.COMPLETE", 1)).toBe(false);
    expect(seasonPackMatchesTitle("Show Season 2 WEB", 1)).toBe(false);
  });
});

describe("knaben.toResult magnet selection", () => {
  it("prefers magnetUrl when present", () => {
    const r = _internals.toResult({ ...baseHit, magnetUrl: "magnet:?xt=urn:btih:NEWEST" });
    expect(r?.magnet).toBe("magnet:?xt=urn:btih:NEWEST");
  });

  it("falls back to magnet field", () => {
    const r = _internals.toResult({ ...baseHit, magnet: "magnet:?xt=urn:btih:OLDER" });
    expect(r?.magnet).toBe("magnet:?xt=urn:btih:OLDER");
  });

  it("reconstructs magnet from hash when no link is provided", () => {
    const r = _internals.toResult({
      ...baseHit,
      hash: "1234567890abcdef1234567890abcdef12345678",
    });
    expect(r?.magnet).toMatch(/^magnet:\?xt=urn:btih:1234567890abcdef/);
  });

  it("returns null when no magnet, no link, no hash", () => {
    const r = _internals.toResult(baseHit);
    expect(r).toBeNull();
  });

  it("filters out xvid releases", () => {
    const r = _internals.toResult({
      ...baseHit,
      title: "Show.S01E05.XViD-GROUP",
      magnet: "magnet:?xt=urn:btih:abc",
    });
    expect(r).toBeNull();
  });

  it("preserves season/episode when tagged", () => {
    const r = _internals.toResult({
      ...baseHit,
      magnet: "magnet:?xt=urn:btih:abc",
      season: 2,
      episode: 7,
    });
    expect(r).toMatchObject({ season: 2, episode: 7 });
  });
});
