/**
 * Masks userinfo in a proxy URL for display.
 * "socks5h://user:pass@host:1080" → "socks5h://****@host:1080"
 * Falls back to "•••" if the URL is unparseable.
 */
export function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "****";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return "•••";
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatBitsPerSec(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatPercent(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/**
 * Formats a seconds value as MM:SS (or H:MM:SS if >= 1 hour). Used by both
 * the browser player and cast controls surfaces so the two feel consistent.
 * Non-finite / negative inputs collapse to "0:00" to match the pre-refactor
 * `CastControls` behavior.
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
