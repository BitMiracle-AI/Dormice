import type { AcquireRequest, LifecyclePolicyOverride } from '@dormice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acquireSandbox,
  destroySandbox,
  getSandboxMetrics,
  listSandboxes,
  listSandboxMetrics,
  rebuildSandbox,
  updatePolicy,
} from '@/lib/api';

/**
 * One entity, one file: every sandbox query and mutation lives here.
 * The list is the only read the daemon offers (it IS the observation
 * window), so the detail view selects from the same cache entry instead of
 * inventing a second endpoint.
 */
export function useSandboxes() {
  return useQuery({
    queryKey: ['sandboxes'],
    queryFn: listSandboxes,
    // The observation window observes: a short poll against a local SQLite
    // read is effectively free, and 2s is faster than the human eye needs.
    refetchInterval: 2000,
    retry: false,
  });
}

export function useSandbox(externalId: string) {
  const query = useSandboxes();
  return {
    ...query,
    sandbox: query.data?.sandboxes.find((s) => s.externalId === externalId),
  };
}

/**
 * 单沙箱指标,5 秒一拍。观察不唤醒:停着的沙箱答 sample: null,面板
 * 据此出空态而不是把沙箱吵醒。只在指标 tab 挂载时才跑(面板卸载即停)。
 */
export function useSandboxMetrics(externalId: string) {
  return useQuery({
    queryKey: ['sandbox-metrics', externalId],
    queryFn: () => getSandboxMetrics(externalId),
    refetchInterval: 5000,
    retry: false,
  });
}

/**
 * 全部可测沙箱的资源快照,一个请求管一整张表(逐行发 getSandboxMetrics
 * 是 N 倍浪费)。答案里没出现 = 没有容器可测(停止/归档),不是 0。
 * 5 秒一拍与列表的 2 秒分开定:daemon 侧一次 docker stats 读数约一秒,
 * 这口锅比读 SQLite 贵。只在列表页挂载时跑,页面一关轮询即停。
 */
export function useFleetMetrics() {
  return useQuery({
    queryKey: ['fleet-metrics'],
    queryFn: listSandboxMetrics,
    refetchInterval: 5000,
    retry: false,
  });
}

export function useAcquireSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: AcquireRequest) => acquireSandbox(request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sandboxes'] }),
  });
}

export function useUpdatePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      externalId: string;
      policy: LifecyclePolicyOverride;
    }) => updatePolicy(args.externalId, args.policy),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sandboxes'] }),
  });
}

export function useRebuildSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (externalId: string) => rebuildSandbox(externalId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sandboxes'] }),
  });
}

export function useDestroySandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (externalId: string) => destroySandbox(externalId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sandboxes'] }),
  });
}
