import { useQuery } from '@tanstack/react-query';
import { getConfig } from '@/lib/api';

/**
 * 生效配置基本不变(改它要动 env + 重启 daemon),不轮询;窗口重新聚焦
 * 时的默认 refetch 已经足够新鲜。创建沙箱表单也吃它 — archive.enabled
 * 决定归档旋钮是否存在。
 */
export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
    staleTime: 30_000,
    retry: false,
  });
}
