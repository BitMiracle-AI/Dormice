import type { HostMetricsResponse } from '@dormice/shared';
import {
  CpuIcon,
  Database01Icon,
  HardDriveIcon,
  PackageIcon,
  RamMemoryIcon,
  SnowIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatBytes, pctOf } from '../format';
import { useHostMetrics } from '../hooks/useHostMetrics';

/**
 * Usage meter: the fill carries severity (quiet below 75%, amber to 90%,
 * red past it) and the unfilled track is a lighter step of the same color,
 * so state reads across the whole bar. Null means "no reading yet" — an
 * empty quiet track, never a fake zero fill.
 */
function Meter({ pct }: { pct: number | null }) {
  const clamped = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const [fill, track] =
    clamped >= 90
      ? ['bg-red-500', 'bg-red-500/15']
      : clamped >= 75
        ? ['bg-amber-500', 'bg-amber-500/15']
        : ['bg-primary', 'bg-primary/10'];
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full', track)}>
      <div
        className={cn('h-full rounded-full transition-[width]', fill)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  pct,
}: {
  icon: NonNullable<HugeiconsProps['icon']>;
  label: string;
  value: string;
  hint: ReactNode;
  /** Meter percentage; null renders an empty track, undefined no meter. */
  pct?: number | null;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <HugeiconsIcon icon={icon} className="size-4" strokeWidth={1.8} />
          {label}
        </div>
        <div className="text-2xl font-semibold">{value}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
        {pct !== undefined && <Meter pct={pct} />}
      </CardContent>
    </Card>
  );
}

// The lifecycle rungs shown in the fleet card, coldest last — same hues as
// SandboxStateBadge so the two read as one system. archived and restoring
// only appear once they exist (no archiver yet — nothing is promised).
const STATE_DOTS: Array<{
  key: keyof HostMetricsResponse['sandboxes']['byState'];
  dot: string;
  alwaysShown: boolean;
}> = [
  { key: 'active', dot: 'bg-emerald-500', alwaysShown: true },
  { key: 'frozen', dot: 'bg-sky-500', alwaysShown: true },
  { key: 'stopped', dot: 'bg-muted-foreground/50', alwaysShown: true },
  { key: 'archived', dot: 'bg-violet-500', alwaysShown: false },
  { key: 'restoring', dot: 'bg-amber-500', alwaysShown: false },
];

function StateCounts({
  byState,
}: {
  byState: HostMetricsResponse['sandboxes']['byState'];
}) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {STATE_DOTS.filter((s) => s.alwaysShown || byState[s.key] > 0).map(
        (s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full', s.dot)} />
            <span className="font-medium text-foreground">
              {byState[s.key]}
            </span>
            {s.key}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * The dashboard's card row: is the host healthy, and what does the fleet
 * cost it? Swap and the data disk get equal billing with CPU and memory
 * because on this platform they are the two that kill: full swap ends
 * "idle is free", a full data disk ends creation entirely.
 */
export function OverviewCards() {
  const query = useHostMetrics();

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{query.error.message}</AlertDescription>
      </Alert>
    );
  }

  if (!query.data) {
    // One placeholder per card in the top row, keyed by what will load there.
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {['cpu', 'memory', 'swap', 'data-disk'].map((slot) => (
          <Skeleton
            key={slot}
            className="h-28 rounded-[min(var(--radius-4xl),24px)]"
          />
        ))}
      </div>
    );
  }

  const { host, dataDisk, sandboxes, sandboxDisks } = query.data;
  const memUsed = host.memTotalBytes - host.memAvailableBytes;

  return (
    <section className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={CpuIcon}
          label="CPU"
          value={
            host.cpuUsedPct === null ? '—' : `${Math.round(host.cpuUsedPct)}%`
          }
          hint={`${host.cpuCount} core${host.cpuCount === 1 ? '' : 's'}`}
          pct={host.cpuUsedPct}
        />
        <StatCard
          icon={RamMemoryIcon}
          label="Memory"
          value={formatBytes(memUsed)}
          hint={`of ${formatBytes(host.memTotalBytes)} · ${formatBytes(host.memAvailableBytes)} available`}
          pct={pctOf(memUsed, host.memTotalBytes)}
        />
        {host.swap === null ? (
          <StatCard
            icon={SnowIcon}
            label="Swap"
            value="—"
            hint="no reading on this platform"
          />
        ) : host.swap.totalBytes === 0 ? (
          <StatCard
            icon={SnowIcon}
            label="Swap"
            value="none"
            hint={
              <span className="text-amber-600 dark:text-amber-500">
                freezing needs swap — see dor doctor
              </span>
            }
          />
        ) : (
          <StatCard
            icon={SnowIcon}
            label="Swap"
            value={formatBytes(host.swap.usedBytes)}
            hint={`of ${formatBytes(host.swap.totalBytes)} · frozen sandboxes live here`}
            pct={pctOf(host.swap.usedBytes, host.swap.totalBytes)}
          />
        )}
        {dataDisk === null ? (
          <StatCard
            icon={HardDriveIcon}
            label="Data disk"
            value="—"
            hint="no data directory on this host"
          />
        ) : (
          <StatCard
            icon={HardDriveIcon}
            label="Data disk"
            value={formatBytes(dataDisk.usedBytes)}
            hint={
              <span title={dataDisk.path}>
                {`of ${formatBytes(dataDisk.totalBytes)} · ${formatBytes(dataDisk.availableBytes)} free`}
              </span>
            }
            pct={pctOf(dataDisk.usedBytes, dataDisk.totalBytes)}
          />
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <StatCard
          icon={PackageIcon}
          label="Sandboxes"
          value={`${sandboxes.total} / ${sandboxes.maxSandboxes}`}
          hint={<StateCounts byState={sandboxes.byState} />}
          pct={pctOf(sandboxes.total, sandboxes.maxSandboxes)}
        />
        <StatCard
          icon={Database01Icon}
          label="Sandbox disks"
          value={formatBytes(sandboxDisks.actualBytes)}
          hint={`promised ${formatBytes(sandboxDisks.nominalBytes)} across ${sandboxDisks.count} disk${sandboxDisks.count === 1 ? '' : 's'} — sparse images only cost what they hold`}
          pct={pctOf(sandboxDisks.actualBytes, sandboxDisks.nominalBytes)}
        />
      </div>
    </section>
  );
}
