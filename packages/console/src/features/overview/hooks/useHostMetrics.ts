import { useQuery } from '@tanstack/react-query';
import { getHostMetrics } from '@/lib/api';

export function useHostMetrics() {
  return useQuery({
    queryKey: ['hostMetrics'],
    queryFn: getHostMetrics,
    // Slower than the sandbox list on purpose: CPU usage is a delta between
    // consecutive requests, and a 5s interval keeps that reading meaningful
    // where a 2s one would mostly sample noise.
    refetchInterval: 5000,
    retry: false,
  });
}
