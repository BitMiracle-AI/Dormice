import type { Sandbox } from '@dormice/shared';
import {
  CpuIcon,
  HardDriveIcon,
  RamMemoryIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { formatBytes, pctOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { since } from '../format';
import { useSandboxMetrics } from '../hooks/useSandboxes';

function Meter({ pct }: { pct: number }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const [fill, track] =
    clamped >= 90
      ? ['bg-red-500', 'bg-red-500/15']
      : clamped >= 75
        ? ['bg-amber-500', 'bg-amber-500/15']
        : ['bg-primary', 'bg-primary/10'];
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full', track)}>
      <div
        className={cn('h-full rounded-full', fill)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  hint,
  pct,
}: {
  icon: NonNullable<HugeiconsProps['icon']>;
  label: string;
  value: string;
  hint: string;
  pct: number;
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
        <Meter pct={pct} />
      </CardContent>
    </Card>
  );
}

/**
 * 单沙箱指标:5 秒一拍的单次快照(观察窗不是监控系统)。观察不唤醒 —
 * 冻结的沙箱睡着也能读(cgroup 记账还在),停了的沙箱没有容器可测,
 * daemon 答 null,这里出空态而不是把它吵醒。
 */
export function MetricsPanel({ sandbox }: { sandbox: Sandbox }) {
  const { data, isPending, isError, error } = useSandboxMetrics(
    sandbox.userKey,
  );

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> 读取指标…
      </div>
    );
  }
  if (isError) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>读取失败</EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const sample = data.sample;
  if (sample === null) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>没有运行中的容器可测</EmptyTitle>
          <EmptyDescription>
            沙箱现在没有活着的容器(已停止/已归档)。观察不唤醒 —
            打开终端或执行命令才会把它叫醒。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          icon={CpuIcon}
          label="CPU"
          value={`${Math.round(sample.cpuUsedPct)}%`}
          hint={`${sample.cpuCount} 核 · 百分比按单核计`}
          pct={sample.cpuUsedPct / sample.cpuCount}
        />
        <MetricCard
          icon={RamMemoryIcon}
          label="内存"
          value={formatBytes(sample.memUsedBytes)}
          hint={`共 ${formatBytes(sample.memTotalBytes)} · 缓存 ${formatBytes(sample.memCacheBytes)}`}
          pct={pctOf(sample.memUsedBytes, sample.memTotalBytes)}
        />
        <MetricCard
          icon={HardDriveIcon}
          label="磁盘"
          value={formatBytes(sample.diskUsedBytes)}
          hint={`名义 ${formatBytes(sample.diskTotalBytes)} — 稀疏镜像只为真实内容付费`}
          pct={pctOf(sample.diskUsedBytes, sample.diskTotalBytes)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        单次快照,5 秒刷新;本次读数取自 {since(sample.timestamp)}前。
      </p>
    </div>
  );
}
