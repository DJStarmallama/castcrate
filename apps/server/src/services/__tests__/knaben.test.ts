import { describe, it, expect } from "vitest";
import { episodeMatchesTitle } from "../knaben.js";

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
