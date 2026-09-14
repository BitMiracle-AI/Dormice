import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  rangeSpanMs,
  type TimelineRangeKey,
} from '@/features/overview/hooks/useFleetTimeline';
import {
  gatewayHealth,
  getHostMetrics,
  getHostMetricsHistory,
  listNodes,
  removeNode,
  updateNodeSettings,
} from '@/lib/api';

/**
 * The nodes as the gateway knows them, one file (the sandboxes' rule):
 * every read and write about a node. The list is what the gateway holds
 * in memory from the check-ins — polling it costs no node anything, so
 * 5s is the overview's cadence, not the sandbox list's 2s.
 */
export function useNodes() {
  return useQuery({
    queryKey: ['nodes'],
    queryFn: listNodes,
    refetchInterval: 5000,
    retry: false,
  });
}

/** One node, selected from the same list cache — the list is the gateway's one read about nodes. */
export function useNode(id: string) {
  const query = useNodes();
  return { ...query, node: query.data?.nodes.find((n) => n.id === id) };
}

/**
 * The gateway's own build, off /healthz (open, no token): the nodes page
 * marks a node whose build differs from it. A build changes when the
 * gateway restarts — refetch on focus is plenty.
 */
export function useGatewayHealth() {
  return useQuery({
    queryKey: ['gatewayHealth'],
    queryFn: gatewayHealth,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * One machine's live reading, by node: CPU is a delta between consecutive
 * requests, and 5s keeps that reading meaningful where 2s would mostly
 * sample noise. Only mounted on that node's page — a poll per node per
 * page open, never per node per fleet.
 */
export function useNodeHostMetrics(nodeId: string) {
  return useQuery({
    queryKey: ['hostMetrics', nodeId],
    queryFn: () => getHostMetrics(nodeId),
    refetchInterval: 5000,
    retry: false,
  });
}

/**
 * One machine's history, following the page's range — the fleet
 * timeline's cadence exactly: 30s (the node's sampling interval; faster
 * only rereads the same rows), the window computed per queryFn so a
 * page left open slides, keepPreviousData across a range switch.
 */
export function useNodeHostTimeline(nodeId: string, range: TimelineRangeKey) {
  return useQuery({
    queryKey: ['hostTimeline', nodeId, range],
    queryFn: () => {
      const end = Date.now();
      const start = end - rangeSpanMs(range);
      return getHostMetricsHistory(
        nodeId,
        new Date(start).toISOString(),
        new Date(end).toISOString(),
      );
    },
    refetchInterval: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/** The one per-node knob; the config version counts up with it, so the settings page's version refreshes too. */
export function useUpdateNodeSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; swapGb: number }) =>
      updateNodeSettings(args.id, args.swapGb),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['nodes'] });
      void queryClient.invalidateQueries({ queryKey: ['config'] });
    },
  });
}

/** Removal is the gateway's ruling: a node still checking in is refused (409) with the reason, relayed as it came. */
export function useRemoveNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeNode(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['nodes'] }),
  });
}
