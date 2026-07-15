import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { checkUpgrade } from '@/lib/api';

/**
 * 版本检查只在打开设置页与点按钮时发生 — 刻意不做后台轮询(检查会打
 * 远端仓库,后台跑等于 phone home);daemon 侧另有一小时缓存,反复进
 * 页面不重复走网络。检查失败是数据(checkError)不是异常,卡片如实显示。
 */
export function useCheckUpgrade() {
  return useQuery({
    queryKey: ['checkUpgrade'],
    queryFn: () => checkUpgrade(),
    staleTime: 3600_000,
    retry: false,
  });
}

/** 「检查更新」按钮:force 穿透 daemon 缓存,结果写回同一份查询缓存。 */
export function useForceCheckUpgrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => checkUpgrade(true),
    onSuccess: (data) => queryClient.setQueryData(['checkUpgrade'], data),
  });
}
