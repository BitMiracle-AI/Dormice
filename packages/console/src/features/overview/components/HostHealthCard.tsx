import {
  CpuIcon,
  HardDriveIcon,
  RamMemoryIcon,
  SnowIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import type { ReactNode } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, pctOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useHostMetrics } from '../hooks/useHostMetrics';
import { Meter } from './Meter';

function HostRow({
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
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <HugeiconsIcon
            icon={icon}
            className="size-4 text-muted-foreground"
            strokeWidth={1.8}
          />
          {label}
        </span>
        <span className="text-sm text-muted-foreground tabular-nums">
          {value}
        </span>
      </div>
      {pct !== undefined && <Meter pct={pct} />}
      <div className="text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

/**
 * 宿主健康竖卡:主图旁边的机器体征列(对位 openasi 的 ModelStatus 卡)。
 * Swap 和数据盘与 CPU、内存平起平坐,因为在这个平台上它们才是要命的
 * 两个:swap 满了「空闲即免费」就完了,数据盘满了连创建都完了。沙箱
 * 磁盘的账单在页面底部一行 — 这张卡只讲机器本身。
 */
export function HostHealthCard({ className }: { className?: string }) {
  const query = useHostMetrics();

  return (
    <Card size="sm" className={cn('flex flex-col', className)}>
      <CardHeader>
        <CardTitle>宿主健康</CardTitle>
        <CardDescription>这台机器的资源水位</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-5">
        <HostHealthRows query={query} />
      </CardContent>
    </Card>
  );
}

function HostHealthRows({
  query,
}: {
  query: ReturnType<typeof useHostMetrics>;
}) {
  if (query.isError) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-destructive">
        {query.error.message}
      </div>
    );
  }

  if (!query.data) {
    // 骨架镜像真实行解剖(标签+数值 / 量表 / 说明),四行等高不跳动。
    return (
      <>
        {['cpu', 'memory', 'swap', 'data-disk'].map((slot) => (
          <div key={slot} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-12" />
            </div>
            <Skeleton className="h-1.5 w-full rounded-full" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </>
    );
  }

  const { host, dataDisk } = query.data;
  const memUsed = host.memTotalBytes - host.memAvailableBytes;

  return (
    <>
      <HostRow
        icon={CpuIcon}
        label="CPU"
        value={
          host.cpuUsedPct === null ? '—' : `${Math.round(host.cpuUsedPct)}%`
        }
        hint={`${host.cpuCount} 核`}
        pct={host.cpuUsedPct}
      />
      <HostRow
        icon={RamMemoryIcon}
        label="内存"
        value={formatBytes(memUsed)}
        hint={`共 ${formatBytes(host.memTotalBytes)} · 可用 ${formatBytes(host.memAvailableBytes)}`}
        pct={pctOf(memUsed, host.memTotalBytes)}
      />
      {host.swap === null ? (
        <HostRow
          icon={SnowIcon}
          label="Swap"
          value="—"
          hint="此平台读不到 swap"
        />
      ) : host.swap.totalBytes === 0 ? (
        <HostRow
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
        <HostRow
          icon={SnowIcon}
          label="Swap"
          value={formatBytes(host.swap.usedBytes)}
          hint={`共 ${formatBytes(host.swap.totalBytes)} · 冻结的沙箱住在这里`}
          pct={pctOf(host.swap.usedBytes, host.swap.totalBytes)}
        />
      )}
      {dataDisk === null ? (
        <HostRow
          icon={HardDriveIcon}
          label="数据盘"
          value="—"
          hint="这台主机没有数据目录"
        />
      ) : (
        <HostRow
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
    </>
  );
}
