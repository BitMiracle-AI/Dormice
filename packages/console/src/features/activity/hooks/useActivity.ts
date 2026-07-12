import { useQuery } from '@tanstack/react-query';
import { listActivity } from '@/lib/api';

/**
 * 活动流是观察窗:5 秒轮询即可 — 事件写在动作发生处,读只是翻账本,
 * 比沙箱列表的 2 秒松一档(历史不像状态那样急着看)。
 *
 * limit 缺省用 wire 默认(200);详情页历史 tab 要按 userKey 过滤,
 * 传环形表上限(1000)把一个沙箱的事件尽量捞全。
 */
export function useActivity(limit?: number) {
  return useQuery({
    queryKey: ['activity', limit ?? null],
    queryFn: () => listActivity(limit),
    refetchInterval: 5000,
    retry: false,
  });
}
