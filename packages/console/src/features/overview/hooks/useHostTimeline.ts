import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getHostMetricsHistory } from '@/lib/api';
import { rangeSpanMs, type TimelineRangeKey } from './useFleetTimeline';

/**
 * 宿主机的走势,跟随总览页的全局档位 — 节奏与 useFleetTimeline 完全同款:
 * 30 秒一刷(同 daemon 采样间隔,更快只是重复读同一批样本)、窗口在
 * queryFn 里现算随时间滑动、切档位时 keepPreviousData 顶住不塌骨架。
 */
export function useHostTimeline(range: TimelineRangeKey) {
  return useQuery({
    queryKey: ['hostTimeline', range],
    queryFn: () => {
      const end = Date.now();
      const start = end - rangeSpanMs(range);
      return getHostMetricsHistory(
        new Date(start).toISOString(),
        new Date(end).toISOString(),
      );
    },
    refetchInterval: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
