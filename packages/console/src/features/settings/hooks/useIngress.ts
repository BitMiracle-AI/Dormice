import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getIngress, setIngress } from '@/lib/api';

/**
 * daemon 前门(反向代理)的观察与绑定。绑定后证书由 Caddy 后台申请,
 * 收敛前(域名已绑但 TLS 探测还没绿)每 5s 轮询让进度是真的;收敛后
 * 停表 — 一张绿卡不值得持续打 DNS。
 */
export function useIngress() {
  return useQuery({
    queryKey: ['ingress'],
    queryFn: getIngress,
    refetchInterval: (query) => {
      const status = query.state.data;
      return status?.domain && !status.probe?.tlsOk ? 5_000 : false;
    },
    retry: false,
  });
}

export function useSetIngress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setIngress,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['ingress'] }),
  });
}
