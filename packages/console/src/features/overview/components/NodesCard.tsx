import { Link } from '@tanstack/react-router';
import { Meter } from '@/components/Meter';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodes } from '@/features/nodes/hooks/useNodes';
import { formatBytes, pctOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages';

/**
 * 节点竖卡:主图旁边每台机器一行(2026-09-15 集群刀 3,取代宿主健康
 * 卡 — 舰队里没有「这台机器」)。每行三条量表 CPU/内存/数据盘 + 运行中
 * 沙箱数,读的是网关手里每台最近一次报到的读数(listNodes,5s 轮询,
 * 不扇出到任何节点);走势与峰值不在这里 — 点进节点页,那里按台问。
 * 单机也是一行:一台节点的舰队,产品故事不因机器数变形。
 *
 * 有节点还没报到时,卡头改说「N 台中 M 台已报到」— 顶排四卡加的是
 * 已报到那几台的数,下界要说出来。
 */
export function NodesCard({ className }: { className?: string }) {
  const query = useNodes();
  const nodes = [...(query.data?.nodes ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const reported = nodes.filter((n) => n.reading !== null).length;

  return (
    <Card size="sm" className={cn('flex flex-col', className)}>
      <CardHeader>
        <CardTitle>{m.overview_nodes_title()}</CardTitle>
        <CardDescription>
          {nodes.length > 0 && reported < nodes.length
            ? m.overview_nodes_reported({ total: nodes.length, reported })
            : m.overview_nodes_desc()}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {query.isError ? (
          <div className="flex flex-1 items-center justify-center text-sm text-destructive">
            {query.error.message}
          </div>
        ) : !query.data ? (
          ['a', 'b'].map((slot) => (
            <div key={slot} className="flex flex-col gap-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-1.5 w-full rounded-full" />
              <Skeleton className="h-1.5 w-full rounded-full" />
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
          ))
        ) : nodes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {m.overview_nodes_empty()}
          </div>
        ) : (
          nodes.map((node) => <NodeRow key={node.id} node={node} />)
        )}
      </CardContent>
      <CardFooter>
        <Link
          to="/nodes"
          className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          {m.overview_nodes_all()}
        </Link>
      </CardFooter>
    </Card>
  );
}

function NodeRow({
  node,
}: {
  node: NonNullable<ReturnType<typeof useNodes>['data']>['nodes'][number];
}) {
  const reading = node.reading;
  const memUsed =
    reading === null
      ? null
      : reading.host.memTotalBytes - reading.host.memAvailableBytes;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Link
          to="/nodes/$id"
          params={{ id: node.id }}
          className="flex min-w-0 items-center gap-2 font-mono text-sm font-medium hover:underline"
          title={node.endpoint}
        >
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              node.reachable ? 'bg-emerald-500' : 'bg-red-500',
            )}
            title={node.reachable ? m.nodes_reachable() : m.nodes_unreachable()}
          />
          <span className="truncate">{node.id}</span>
        </Link>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {reading === null
            ? m.nodes_no_reading()
            : m.overview_nodes_running({
                n: reading.sandboxes.byState.active,
              })}
        </span>
      </div>
      <MiniMeter
        label={m.nodes_col_cpu()}
        pct={reading?.host.cpuUsedPct ?? null}
        value={
          reading?.host.cpuUsedPct === null || reading === null
            ? '—'
            : `${Math.round(reading.host.cpuUsedPct)}%`
        }
      />
      <MiniMeter
        label={m.nodes_col_memory()}
        pct={
          reading === null || memUsed === null
            ? null
            : pctOf(memUsed, reading.host.memTotalBytes)
        }
        value={memUsed === null ? '—' : formatBytes(memUsed)}
      />
      <MiniMeter
        label={m.nodes_col_disk()}
        pct={
          reading?.dataDisk
            ? pctOf(reading.dataDisk.usedBytes, reading.dataDisk.totalBytes)
            : null
        }
        value={
          reading?.dataDisk ? formatBytes(reading.dataDisk.usedBytes) : '—'
        }
      />
    </div>
  );
}

function MiniMeter({
  label,
  pct,
  value,
}: {
  label: string;
  pct: number | null;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-10 shrink-0 text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">
        <Meter pct={pct} />
      </div>
      <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}
