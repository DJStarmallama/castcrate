import { describe, it, expect } from "vitest";
import { srtToVtt } from "../srt.js";

describe("srtToVtt", () => {
  it("prepends WEBVTT header", () => {
    expect(srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nhi\n")).toMatch(/^WEBVTT\n\n/);
  });

  it("converts comma decimals to dot decimals in timestamps", () => {
    const out = srtToVtt("1\n00:00:01,234 --> 00:00:02,345\nhi\n");
    expect(out).toContain("00:00:01.234 --> 00:00:02.345");
  });

  it("converts CRLF line endings to LF", () => {
    const out = srtToVtt("1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\n");
    expect(out).not.toContain("\r");
  });

  it("strips a leading BOM", () => {
    const out = srtToVtt("﻿1\n00:00:01,000 --> 00:00:02,000\nhi\n");
    expect(out.startsWith("WEBVTT")).toBe(true);
  });

  it("preserves multi-cue files", () => {
    const out = srtToVtt(
      "1\n00:00:01,000 --> 00:00:02,000\nfirst\n\n2\n00:00:03,500 --> 00:00:04,000\nsecond\n",
    );
    expect(out).toContain("first");
    expect(out).toContain("second");
    expect(out).toContain("00:00:03.500");
  });

  it("does not touch non-timestamp commas", () => {
    const out = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nhello, world\n");
    expect(out).toContain("hello, world");
  });
});
