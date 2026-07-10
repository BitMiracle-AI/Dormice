import type { AcquireRequest } from '@dormice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acquireSandbox,
  listSandboxes,
  rebuildSandbox,
  releaseSandbox,
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

export function useAcquireSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: AcquireRequest) => acquireSandbox(request),
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
