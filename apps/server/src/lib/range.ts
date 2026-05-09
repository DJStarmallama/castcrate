export interface Range {
  start: number;
  end: number;
}

export function parseRange(header: string | undefined, size: number): Range | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  let start: number;
  let end: number;
  if (startStr === "" && endStr !== "") {
    const suffix = Number(endStr);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = startStr === "" ? 0 : Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end >= size ||
    start > end
  ) {
    return null;
  }
  return { start, end };
}
