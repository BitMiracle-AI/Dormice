import type { NodeView } from '@dormice/shared';
import {
  CloudServerIcon,
  Delete02Icon,
  MoreHorizontalIcon,
  SnowIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { DataTable } from '@/components/DataTable';
import { Meter } from '@/components/Meter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConfig } from '@/features/settings/hooks/useConfig';
import { formatDateTime } from '@/lib/datetime';
import { formatBytes, pctOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages';
import { ConfigBadge, ReachableBadge } from '../components/NodeBadges';
import { RemoveNodeDialog } from '../components/RemoveNodeDialog';
import { SwapDialog } from '../components/SwapDialog';
import { useGatewayHealth, useNodes } from '../hooks/useNodes';

/**
 * 节点页(2026-09-15 集群刀 3,讨论稿 #24):每台机器一行 — 可达、版本、
 * CPU/内存/数据盘三条量表、沙箱计数、配置漂移 — 读的是网关手里每台最近
 * 一次报到的读数(listNodes,5s 轮询,不扇出到任何节点);页头一张网关卡
 * (它自己的构建、几台节点、配置第几版)。走势与峰值在每台的详情页。
 * 行操作:追加 swap(唯一的每节点旋钮)与移除(只对不可达的节点开放 —
 * 网关对还在报到的节点拒 409,菜单项先把这条规矩写在脸上)。
 *
 * 列宽军备(RULES/前端.md):max-w-6xl 里九列刚好,swap 用量不进表 —
 * 详情页有它,弹窗里也看得到。
 */
export function NodesPage() {
  const query = useNodes();
  const gateway = useGatewayHealth();
  const config = useConfig();
  const nodes = [...(query.data?.nodes ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const currentVersion = config.data?.configVersion;
  const gatewayCommit = gateway.data?.build?.commit;

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-medium">{m.nodes_page_title()}</h1>
      </header>

      <GatewayCard
        build={gateway.data?.build ?? null}
        loaded={gateway.isSuccess}
        total={nodes.length}
        reachable={nodes.filter((n) => n.reachable).length}
        version={currentVersion}
      />

      {query.isError && (
        <Alert variant="destructive" className="shrink-0">
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      )}

      {query.isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {m.nodes_loading()}
        </div>
      )}

      {query.isSuccess && nodes.length === 0 && (
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={CloudServerIcon} />
            </EmptyMedia>
            <EmptyTitle>{m.nodes_empty_title()}</EmptyTitle>
            <EmptyDescription>{m.nodes_empty_description()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {nodes.length > 0 && (
        <DataTable fill>
          <TableHeader>
            <TableRow>
              <TableHead>{m.nodes_col_node()}</TableHead>
              <TableHead>{m.nodes_col_status()}</TableHead>
              <TableHead>{m.nodes_col_build()}</TableHead>
              <TableHead className="text-right">{m.nodes_col_cpu()}</TableHead>
              <TableHead className="text-right">
                {m.nodes_col_memory()}
              </TableHead>
              <TableHead className="text-right">{m.nodes_col_disk()}</TableHead>
              <TableHead>{m.nodes_col_sandboxes()}</TableHead>
              <TableHead>{m.nodes_col_config()}</TableHead>
              <TableHead className="text-right">
                {m.nodes_col_actions()}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((node) => (
              <NodeRow
                key={node.id}
                node={node}
                currentVersion={currentVersion}
                gatewayCommit={gatewayCommit}
              />
            ))}
          </TableBody>
        </DataTable>
      )}
    </div>
  );
}

/**
 * 网关自己的一张卡:构建、节点几台几台可达、配置第几版 — 网关是舰队
 * 唯一的门,它的版本是节点「与网关不同」标记的参照。
 */
function GatewayCard({
  build,
  loaded,
  total,
  reachable,
  version,
}: {
  build: { commit: string; title: string; committedAt: string } | null;
  loaded: boolean;
  total: number;
  reachable: number;
  version: number | undefined;
}) {
  return (
    <Card size="sm" className="shrink-0">
      <CardHeader>
        <CardTitle>{m.nodes_gateway_title()}</CardTitle>
        <CardDescription>{m.nodes_gateway_desc()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <span
          className="font-mono"
          title={
            build
              ? `${build.title} · ${formatDateTime(build.committedAt)}`
              : undefined
          }
        >
          {build
            ? m.nodes_gateway_build({ commit: build.commit })
            : loaded
              ? m.nodes_gateway_build_unknown()
              : '—'}
        </span>
        <span className="tabular-nums">
          {m.nodes_gateway_fleet({ total, reachable })}
        </span>
        <span className="tabular-nums">
          {version === undefined ? '—' : m.nodes_gateway_config({ version })}
        </span>
      </CardContent>
    </Card>
  );
}

/**
 * 资源列的一格:量表是主角,数字是 text-xs 注脚(沙箱列表的主次对调,
 * 2026-07-18 用户拍板);null = 这台还没报过读数。
 */
function MeterCell({ pct, value }: { pct: number | null; value: string }) {
  return (
    <TableCell
      className={cn(
        'text-right text-xs tabular-nums',
        pct !== null && pct >= 90
          ? 'text-red-600 dark:text-red-400'
          : pct !== null && pct >= 75
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground',
      )}
    >
      {value}
      <div className="mt-1 ml-auto w-20">
        <Meter pct={pct} />
      </div>
    </TableCell>
  );
}

function NodeRow({
  node,
  currentVersion,
  gatewayCommit,
}: {
  node: NodeView;
  currentVersion: number | undefined;
  gatewayCommit: string | undefined;
}) {
  const reading = node.reading;
  const memUsed =
    reading === null
      ? null
      : reading.host.memTotalBytes - reading.host.memAvailableBytes;
  return (
    <TableRow>
      <TableCell className="font-mono font-medium">
        <Link
          to="/nodes/$id"
          params={{ id: node.id }}
          className="hover:underline"
          title={node.endpoint}
        >
          {node.id}
        </Link>
      </TableCell>
      <TableCell>
        <ReachableBadge node={node} />
      </TableCell>
      <TableCell>
        {node.build === null ? (
          <span className="text-muted-foreground">{m.common_unknown()}</span>
        ) : (
          <span
            className="inline-flex items-center gap-2"
            title={`${node.build.title} · ${formatDateTime(node.build.committedAt)}`}
          >
            <span className="font-mono">{node.build.commit}</span>
            {gatewayCommit !== undefined &&
              node.build.commit !== gatewayCommit && (
                <Badge
                  variant="outline"
                  className="border-transparent bg-amber-500/10 font-medium text-amber-600 dark:text-amber-400"
                >
                  {m.nodes_build_differs()}
                </Badge>
              )}
          </span>
        )}
      </TableCell>
      <MeterCell
        pct={reading?.host.cpuUsedPct ?? null}
        value={
          reading === null || reading.host.cpuUsedPct === null
            ? '—'
            : `${Math.round(reading.host.cpuUsedPct)}%`
        }
      />
      <MeterCell
        pct={
          reading === null || memUsed === null
            ? null
            : pctOf(memUsed, reading.host.memTotalBytes)
        }
        value={
          reading === null || memUsed === null
            ? '—'
            : `${formatBytes(memUsed)} / ${formatBytes(reading.host.memTotalBytes)}`
        }
      />
      <MeterCell
        pct={
          reading?.dataDisk
            ? pctOf(reading.dataDisk.usedBytes, reading.dataDisk.totalBytes)
            : null
        }
        value={
          reading?.dataDisk
            ? `${formatBytes(reading.dataDisk.usedBytes)} / ${formatBytes(reading.dataDisk.totalBytes)}`
            : '—'
        }
      />
      <TableCell className="text-xs text-muted-foreground tabular-nums">
        {reading === null
          ? m.nodes_no_reading()
          : m.nodes_sandboxes_cell({
              active: reading.sandboxes.byState.active,
              frozen: reading.sandboxes.byState.frozen,
              total: reading.sandboxes.total,
            })}
      </TableCell>
      <TableCell>
        <ConfigBadge version={node.configVersion} current={currentVersion} />
      </TableCell>
      <TableCell className="text-right">
        <NodeRowMenu node={node} />
      </TableCell>
    </TableRow>
  );
}

/**
 * 行操作收进「⋯」菜单;两个弹窗挂在菜单外受控 — 菜单关闭即卸载,
 * 放里面会跟着消失(RULES/前端.md)。
 */
function NodeRowMenu({ node }: { node: NodeView }) {
  const [swapOpen, setSwapOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={m.nodes_row_actions_aria({ id: node.id })}
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} className="size-5" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className="font-medium"
            onClick={() => setSwapOpen(true)}
          >
            <HugeiconsIcon icon={SnowIcon} strokeWidth={2} />
            {m.nodes_menu_swap()}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            className="font-medium"
            disabled={node.reachable}
            title={node.reachable ? m.nodes_menu_remove_hint() : undefined}
            onClick={() => setRemoveOpen(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {m.nodes_menu_remove()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SwapDialog node={node} open={swapOpen} onOpenChange={setSwapOpen} />
      <RemoveNodeDialog
        id={node.id}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
      />
    </>
  );
}
