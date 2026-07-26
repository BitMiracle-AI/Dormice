import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getFleetTimeline } from '@/lib/api';
import { m } from '@/paraglide/messages';

/**
 * 时间档位与其毫秒宽度 — 切换器与查询共用一份。label 是函数:清单在
 * 模块顶层求值,渲染时再调用才拿到当下语言(同 nav.ts 的纪律)。
 */
export const TIMELINE_RANGES = [
  { key: '1h', label: m.overview_range_1h, spanMs: 3600_000 },
  { key: '24h', label: m.overview_range_24h, spanMs: 24 * 3600_000 },
  { key: '7d', label: m.overview_range_7d, spanMs: 7 * 86_400_000 },
  { key: '30d', label: m.overview_range_30d, spanMs: 30 * 86_400_000 },
] as const;

export type TimelineRangeKey = (typeof TIMELINE_RANGES)[number]['key'];

export function rangeSpanMs(key: TimelineRangeKey): number {
  // TIMELINE_RANGES 穷尽了 key 的取值,find 必中。
  const range = TIMELINE_RANGES.find((r) => r.key === key);
  if (!range) throw new Error(`unknown timeline range ${key}`);
  return range.spanMs;
}

/**
 * 舰队时间线,跟随档位轮询。30 秒一刷 — 与 daemon 的默认采样间隔同步,
 * 更快只是重复读到同一批快照。窗口在每次 queryFn 里现算,所以长开的
 * 页面窗口会随时间滑动。切换档位时沿用上一档的数据顶住新答案到来
 * (keepPreviousData),整卡不塌回骨架屏。
 */
export function useFleetTimeline(range: TimelineRangeKey) {
  return useQuery({
    queryKey: ['fleetTimeline', range],
    queryFn: () => {
      const end = Date.now();
      const start = end - rangeSpanMs(range);
      return getFleetTimeline(
        new Date(start).toISOString(),
        new Date(end).toISOString(),
      );
    },
    refetchInterval: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
