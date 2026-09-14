import { useQuery } from '@tanstack/react-query';
import { getFleetMetrics } from '@/lib/api';

/**
 * The fleet's present — the figures that add up, from the nodes' last
 * check-ins. The gateway answers from memory, so this poll reaches no
 * node: the one observer of the fleet must not be its heaviest caller
 * (design record #24). 5s like the old host poll it replaces.
 */
export function useFleetMetrics() {
  return useQuery({
    queryKey: ['fleetMetrics'],
    queryFn: getFleetMetrics,
    refetchInterval: 5000,
    retry: false,
  });
}
