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
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { STATE_LABELS } from '@/features/sandboxes/format';
import { formatBytes, pctOf } from '@/lib/format';
import { cn } from '@/lib/utils';
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
  to,
}: {
  icon: NonNullable<HugeiconsProps['icon']>;
  label: string;
  value: string;
  hint: ReactNode;
  /** Meter percentage; null renders an empty track, undefined no meter. */
  pct?: number | null;
  /** Route this card drills into; only cards with a real destination get one. */
  to?: string;
}) {
  const card = (
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
  if (!to) return card;
  // Radius mirrors the Card's own, so the focus/hover ring hugs the shape.
  return (
    <Link
      to={to}
      className="block rounded-[min(var(--radius-4xl),24px)] transition-shadow hover:ring-2 hover:ring-primary/30"
    >
      {card}
    </Link>
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
            {STATE_LABELS[s.key]}
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
    // Skeletons mirror the real card anatomy (label / value / hint / meter)
    // and both rows, block heights matched to the text line heights — the
    // loading and loaded states are the same height, so nothing jumps.
    const bones = (slot: string) => (
      <Card key={slot} size="sm">
        <CardContent className="flex flex-col gap-2">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-1.5 w-full rounded-full" />
        </CardContent>
      </Card>
    );
    return (
      <section className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {['cpu', 'memory', 'swap', 'data-disk'].map(bones)}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {['sandboxes', 'sandbox-disks'].map(bones)}
        </div>
      </section>
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
          hint={`${host.cpuCount} 核`}
          pct={host.cpuUsedPct}
        />
        <StatCard
          icon={RamMemoryIcon}
          label="内存"
          value={formatBytes(memUsed)}
          hint={`共 ${formatBytes(host.memTotalBytes)} · 可用 ${formatBytes(host.memAvailableBytes)}`}
          pct={pctOf(memUsed, host.memTotalBytes)}
        />
        {host.swap === null ? (
          <StatCard
            icon={SnowIcon}
            label="Swap"
            value="—"
            hint="此平台读不到 swap"
          />
        ) : host.swap.totalBytes === 0 ? (
          <StatCard
            icon={SnowIcon}
            label="Swap"
            value="未配置"
            hint={
              <span className="text-amber-600 dark:text-amber-500">
                冻结依赖 swap — 见 dor doctor
              </span>
            }
          />
        ) : (
          <StatCard
            icon={SnowIcon}
            label="Swap"
            value={formatBytes(host.swap.usedBytes)}
            hint={`共 ${formatBytes(host.swap.totalBytes)} · 冻结的沙箱住在这里`}
            pct={pctOf(host.swap.usedBytes, host.swap.totalBytes)}
          />
        )}
        {dataDisk === null ? (
          <StatCard
            icon={HardDriveIcon}
            label="数据盘"
            value="—"
            hint="这台主机没有数据目录"
          />
        ) : (
          <StatCard
            icon={HardDriveIcon}
            label="数据盘"
            value={formatBytes(dataDisk.usedBytes)}
            hint={
              <span title={dataDisk.path}>
                {`共 ${formatBytes(dataDisk.totalBytes)} · 剩 ${formatBytes(dataDisk.availableBytes)}`}
              </span>
            }
            pct={pctOf(dataDisk.usedBytes, dataDisk.totalBytes)}
          />
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <StatCard
          icon={PackageIcon}
          label="沙箱"
          value={`${sandboxes.total} / ${sandboxes.maxSandboxes}`}
          hint={<StateCounts byState={sandboxes.byState} />}
          pct={pctOf(sandboxes.total, sandboxes.maxSandboxes)}
          to="/sandboxes"
        />
        <StatCard
          icon={Database01Icon}
          label="沙箱磁盘"
          value={formatBytes(sandboxDisks.actualBytes)}
          hint={`${sandboxDisks.count} 块盘共许诺 ${formatBytes(sandboxDisks.nominalBytes)} — 稀疏镜像只为真实内容付费`}
          pct={pctOf(sandboxDisks.actualBytes, sandboxDisks.nominalBytes)}
          to="/sandboxes"
        />
      </div>
    </section>
  );
}
