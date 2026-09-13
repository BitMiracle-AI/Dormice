import type { CheckInRequest, NodeReading } from '@dormice/shared';

/**
 * Test scaffolding shared by the gateway's suites: a node's reading and
 * check-in with a few knobs turned. Not shipped — nothing under src/ but
 * main.ts is bundled (tsup.config.ts).
 */
export function reading(
  over: {
    cpu?: number | null;
    cores?: number;
    active?: number;
    frozen?: number;
    memAvail?: number;
    diskAvail?: number | null;
  } = {},
): NodeReading {
  const frozen = over.frozen ?? 0;
  const active = over.active ?? 10;
  return {
    host: {
      cpuCount: over.cores ?? 8,
      cpuUsedPct: over.cpu === undefined ? 10 : over.cpu,
      memTotalBytes: 32e9,
      memAvailableBytes: over.memAvail ?? 16e9,
      swap: null,
    },
    dataDisk:
      over.diskAvail === null
        ? null
        : {
            path: '/var/lib/dormice',
            totalBytes: 1e12,
            usedBytes: 1e12 - (over.diskAvail ?? 5e11),
            availableBytes: over.diskAvail ?? 5e11,
          },
    sandboxes: {
      total: active + frozen,
      byState: { active, frozen, stopped: 0, archived: 0, restoring: 0 },
    },
  };
}

export function checkInOf(
  nodeId: string,
  endpoint: string,
  over: Parameters<typeof reading>[0] & { intervalSeconds?: number } = {},
): CheckInRequest {
  return {
    nodeId,
    endpoint,
    intervalSeconds: over.intervalSeconds ?? 15,
    build: {
      commit: 'abc1234',
      title: 'a commit',
      committedAt: '2026-09-14T00:00:00.000Z',
    },
    reading: reading(over),
  };
}
