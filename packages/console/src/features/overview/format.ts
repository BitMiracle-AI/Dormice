/**
 * Bytes in binary units, auto-compact: 512 B, 24.5 MiB, 1.02 TiB. Binary
 * because that is what the numbers physically are (disk images, meminfo) —
 * a 16 GiB swap must read as 16, not 17.2.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** A used/total pair as a percentage, clamped into [0, 100]. */
export function pctOf(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}
