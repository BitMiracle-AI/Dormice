import {
  CpuIcon,
  HardDriveIcon,
  RamMemoryIcon,
  SnowIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { Meter } from '@/components/Meter';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Sparkline } from '@/features/overview/components/Sparkline';
import type { TimelineRangeKey } from '@/features/overview/hooks/useFleetTimeline';
import { ago } from '@/features/sandboxes/format';
import { formatBytes, pctOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages';
import { useNodeHostMetrics, useNodeHostTimeline } from '../hooks/useNodes';

function HostRow({
  icon,
  label,
  value,
  hint,
  pct,
  trend,
}: {
  icon: NonNullable<HugeiconsProps['icon']>;
  label: string;
  value: string;
  hint: ReactNode;
  /** Meter percentage; null renders an empty track, undefined no meter. */
  pct?: number | null;
  /** 窗口内走势;少于两点 Sparkline 自己不画,行高由占位符稳住。 */
  trend?: number[];
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
      {trend !== undefined && (
        <div className="h-5">
          <Sparkline data={trend} className="h-5" />
        </div>
      )}
      <div className="text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

/**
 * 一台节点的机器体征竖卡(2026-09-15 集群刀 3 从总览搬来:总览在多机
 * 世界里没有「这台机器」,宿主的事按节点问)。Swap 和数据盘与 CPU、
 * 内存平起平坐,因为在这个平台上它们才是要命的两个:swap 满了「空闲
 * 即免费」就完了,数据盘满了连创建都完了。沙箱磁盘的账单在总览 — 这
 * 张卡只讲机器本身。
 *
 * 每行的数值是即时读数(5s 轮询,按 nodeId 转到那一台),行内 sparkline
 * 与 CPU 峰值来自那台的 getHostMetricsHistory,跟随页面档位 — 即时值答
 * "现在怎么样",走势答"这个窗口里发生过什么",峰值从原始行来,分桶抹
 * 不平它。
 */
export function NodeHealthCard({
  nodeId,
  range,
  className,
}: {
  nodeId: string;
  range: TimelineRangeKey;
  className?: string;
}) {
  const query = useNodeHostMetrics(nodeId);
  const history = useNodeHostTimeline(nodeId, range);

  return (
    <Card size="sm" className={cn('flex flex-col', className)}>
      <CardHeader>
        <CardTitle>{m.nodes_host_title()}</CardTitle>
        <CardDescription>{m.nodes_host_desc()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-5">
        <HostHealthRows query={query} history={history} />
      </CardContent>
    </Card>
  );
}

function HostHealthRows({
  query,
  history,
}: {
  query: ReturnType<typeof useNodeHostMetrics>;
  history: ReturnType<typeof useNodeHostTimeline>;
}) {
  if (query.isError) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-destructive">
        {query.error.message}
      </div>
    );
  }

  if (!query.data) {
    // 骨架镜像真实行解剖(标签+数值 / 量表 / 走势 / 说明),四行等高不跳动。
    return (
      <>
        {['cpu', 'memory', 'swap', 'data-disk'].map((slot) => (
          <div key={slot} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-12" />
            </div>
            <Skeleton className="h-1.5 w-full rounded-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </>
    );
  }

  const { host, dataDisk } = query.data;
  const memUsed = host.memTotalBytes - host.memAvailableBytes;

  // 历史请求失败或还没答案时走势为空 — Sparkline 少于两点自己不画,
  // 即时读数照常;历史的缺席不该拖垮当下。
  const points = history.data?.points ?? [];
  const peak = history.data?.peak ?? null;
  const cpuTrend = points
    .map((p) => p.cpuUsedPct)
    .filter((v): v is number => v !== null);
  const memTrend = points.map((p) => p.memTotalBytes - p.memAvailableBytes);
  const swapTrend = points
    .map((p) => p.swap?.usedBytes)
    .filter((v): v is number => v !== undefined);
  const diskTrend = points
    .map((p) => p.dataDisk?.usedBytes)
    .filter((v): v is number => v !== undefined);

  return (
    <>
      <HostRow
        icon={CpuIcon}
        label="CPU"
        value={
          host.cpuUsedPct === null ? '—' : `${Math.round(host.cpuUsedPct)}%`
        }
        hint={
          peak === null
            ? m.nodes_host_cpu_cores({ n: host.cpuCount })
            : m.nodes_host_cpu_peak({
                n: host.cpuCount,
                pct: Math.round(peak.cpuUsedPct),
                ago: ago(peak.at),
              })
        }
        pct={host.cpuUsedPct}
        trend={cpuTrend}
      />
      <HostRow
        icon={RamMemoryIcon}
        label={m.nodes_host_mem_label()}
        value={formatBytes(memUsed)}
        hint={m.nodes_host_mem_hint({
          total: formatBytes(host.memTotalBytes),
          available: formatBytes(host.memAvailableBytes),
        })}
        pct={pctOf(memUsed, host.memTotalBytes)}
        trend={memTrend}
      />
      {host.swap === null ? (
        <HostRow
          icon={SnowIcon}
          label="Swap"
          value="—"
          hint={m.nodes_host_swap_unreadable()}
        />
      ) : host.swap.totalBytes === 0 ? (
        <HostRow
          icon={SnowIcon}
          label="Swap"
          value={m.nodes_host_swap_unconfigured()}
          hint={
            <span className="text-amber-600 dark:text-amber-500">
              {m.nodes_host_swap_warning()}
            </span>
          }
        />
      ) : (
        <HostRow
          icon={SnowIcon}
          label="Swap"
          value={formatBytes(host.swap.usedBytes)}
          hint={m.nodes_host_swap_hint({
            total: formatBytes(host.swap.totalBytes),
          })}
          pct={pctOf(host.swap.usedBytes, host.swap.totalBytes)}
          trend={swapTrend}
        />
      )}
      {dataDisk === null ? (
        <HostRow
          icon={HardDriveIcon}
          label={m.nodes_host_disk_label()}
          value="—"
          hint={m.nodes_host_disk_missing()}
        />
      ) : (
        <HostRow
          icon={HardDriveIcon}
          label={m.nodes_host_disk_label()}
          value={formatBytes(dataDisk.usedBytes)}
          hint={
            <span title={dataDisk.path}>
              {m.nodes_host_disk_hint({
                total: formatBytes(dataDisk.totalBytes),
                available: formatBytes(dataDisk.availableBytes),
              })}
            </span>
          }
          pct={pctOf(dataDisk.usedBytes, dataDisk.totalBytes)}
          trend={diskTrend}
        />
      )}
    </>
  );
}
