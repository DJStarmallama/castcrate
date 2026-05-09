/**
 * Convert an SRT subtitle file to WebVTT.
 *
 * Differences:
 *  - VTT requires a "WEBVTT" header line.
 *  - Timestamps use "." not "," as the millisecond separator.
 *  - Cue numbers are optional in VTT (we keep them for stability).
 *  - SRT files are often UTF-8 BOM-prefixed; we strip the BOM.
 */
export function srtToVtt(srt: string): string {
  let body = srt;
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1); // strip BOM
  body = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Replace "00:00:01,234 --> 00:00:02,345" with VTT-compatible "."
  body = body.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})(\s*-->\s*)(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    "$1.$2$3$4.$5",
  );
  // Trim leading/trailing blanks
  body = body.replace(/^\n+/, "").replace(/\n+$/, "\n");
  return `WEBVTT\n\n${body}`;
}
