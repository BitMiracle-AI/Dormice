import type { AcquireRequest, LifecyclePolicyOverride } from '@dormice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acquireSandbox,
  getSandboxMetrics,
  listSandboxes,
  rebuildSandbox,
  releaseSandbox,
  setPolicy,
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

export function useSandbox(userKey: string) {
  const query = useSandboxes();
  return {
    ...query,
    sandbox: query.data?.sandboxes.find((s) => s.userKey === userKey),
  };
}

/**
 * 单沙箱指标,5 秒一拍。观察不唤醒:停着的沙箱答 sample: null,面板
 * 据此出空态而不是把沙箱吵醒。只在指标 tab 挂载时才跑(面板卸载即停)。
 */
export function useSandboxMetrics(userKey: string) {
  return useQuery({
    queryKey: ['sandbox-metrics', userKey],
    queryFn: () => getSandboxMetrics(userKey),
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

export function useSetPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { userKey: string; policy: LifecyclePolicyOverride }) =>
      setPolicy(args.userKey, args.policy),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sandboxes'] }),
  });
}

export function useRebuildSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userKey: string) => rebuildSandbox(userKey),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sandboxes'] }),
  });
}

export function useReleaseSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userKey: string) => releaseSandbox(userKey),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sandboxes'] }),
  });
}
