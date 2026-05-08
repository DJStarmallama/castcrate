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
