import { describe, it, expect } from "vitest";
import { parseRange } from "../range.js";

const SIZE = 1000;

describe("parseRange", () => {
  it("returns null for missing header", () => {
    expect(parseRange(undefined, SIZE)).toBeNull();
  });

  it("returns null for malformed header", () => {
    expect(parseRange("nonsense", SIZE)).toBeNull();
    expect(parseRange("bytes=foo-bar", SIZE)).toBeNull();
    expect(parseRange("bytes=", SIZE)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseRange("bytes=0-99", SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=200-499", SIZE)).toEqual({ start: 200, end: 499 });
  });

  it("parses an open-ended range as size-1", () => {
    expect(parseRange("bytes=500-", SIZE)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=0-", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("parses a suffix range", () => {
    expect(parseRange("bytes=-100", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("clamps a suffix larger than the file", () => {
    expect(parseRange("bytes=-9999", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("rejects out-of-bounds end", () => {
    expect(parseRange("bytes=0-1000", SIZE)).toBeNull();
    expect(parseRange("bytes=0-9999", SIZE)).toBeNull();
  });

  it("rejects inverted ranges", () => {
    expect(parseRange("bytes=500-100", SIZE)).toBeNull();
  });

  it("rejects negative starts that fail to match the regex", () => {
    expect(parseRange("bytes=-100-200", SIZE)).toBeNull();
  });
});
