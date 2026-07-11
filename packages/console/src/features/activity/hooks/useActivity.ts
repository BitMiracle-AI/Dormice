import { useQuery } from '@tanstack/react-query';
import { listActivity } from '@/lib/api';

/**
 * 活动流是观察窗:5 秒轮询即可 — 事件写在动作发生处,读只是翻账本,
 * 比沙箱列表的 2 秒松一档(历史不像状态那样急着看)。
 */
export function useActivity() {
  return useQuery({
    queryKey: ['activity'],
    queryFn: listActivity,
    refetchInterval: 5000,
    retry: false,
  });
}
