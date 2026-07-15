import type { TimelineRangeKey } from './hooks/useFleetTimeline';

/** tooltip 与峰值注脚共用的完整时刻写法。 */
export function fullClock(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    hour12: false,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 长窗口给日期,短窗口给钟点 — 刻度只说这个窗口内有区分度的部分。 */
export function tickFormatter(range: TimelineRangeKey): (ms: number) => string {
  if (range === '7d' || range === '30d') {
    return (ms) => {
      const d = new Date(ms);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    };
  }
  return (ms) =>
    new Date(ms).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
}
