/**
 * 跨域的数字格式化(总览卡片、文件浏览器、指标面板共用)。
 *
 * 字节用二进制单位、自动收敛位数:512 B、24.5 MiB、1.02 TiB。用二进制
 * 是因为这些数字物理上就是二进制的(磁盘镜像、meminfo)— 16 GiB 的
 * swap 必须读作 16,不是 17.2。
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

/** used/total 化成百分比,钳在 [0, 100]。 */
export function pctOf(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}
