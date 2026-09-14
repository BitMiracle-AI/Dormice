import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { RangeSwitcher } from '@/features/overview/components/RangeSwitcher';
import type { TimelineRangeKey } from '@/features/overview/hooks/useFleetTimeline';
import { useConfig } from '@/features/settings/hooks/useConfig';
import { formatDateTime } from '@/lib/datetime';
import { m } from '@/paraglide/messages';
import { ConfigBadge, ReachableBadge } from '../components/NodeBadges';
import { NodeHealthCard } from '../components/NodeHealthCard';
import { useNode } from '../hooks/useNodes';

/**
 * 一台节点的页面:机器体征卡(即时读数 + 走势 + 窗口峰值,按 nodeId
 * 问那一台)配一张信息卡(端点、加入时刻、报到间隔、版本、配置版本、
 * swap 目标与现挂)。基础信息从 5 秒轮询的节点列表缓存里选(列表是
 * 网关关于节点的唯一读);档位切换器与总览同款,驱动体征卡的走势。
 * 纯观察:动作(swap、移除)在列表页的行菜单。
 */
export function NodeDetailPage() {
  const { id } = useParams({ from: '/_app/nodes/$id' });
  const { node, isSuccess } = useNode(id);
  const config = useConfig();
  const [range, setRange] = useState<TimelineRangeKey>('24h');

  if (!node) {
    return isSuccess ? (
      <Empty className="m-4 border border-dashed md:m-6">
        <EmptyHeader>
          <EmptyTitle>{m.nodes_detail_not_found_title({ id })}</EmptyTitle>
          <EmptyDescription>{m.nodes_detail_not_found_desc()}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/nodes" />}
          >
            {m.nodes_detail_back()}
          </Button>
        </EmptyContent>
      </Empty>
    ) : null;
  }

  const reading = node.reading;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-xl font-medium">{node.id}</h1>
          <ReachableBadge node={node} />
        </div>
        <RangeSwitcher range={range} onChange={setRange} />
      </header>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <NodeHealthCard
          nodeId={node.id}
          range={range}
          className="min-h-[420px]"
        />
        <Card size="sm">
          <CardHeader>
            <CardTitle>{m.nodes_detail_info_title()}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <InfoRow label={m.nodes_detail_endpoint()}>
                {node.endpoint}
              </InfoRow>
              <InfoRow label={m.nodes_detail_added_at()}>
                {formatDateTime(node.addedAt)}
              </InfoRow>
              <InfoRow label={m.nodes_detail_interval()}>
                {node.intervalSeconds === null
                  ? '—'
                  : m.nodes_detail_interval_value({ n: node.intervalSeconds })}
              </InfoRow>
              <InfoRow label={m.nodes_detail_build()}>
                {node.build === null ? (
                  m.common_unknown()
                ) : (
                  <span
                    title={`${node.build.title} · ${formatDateTime(node.build.committedAt)}`}
                  >
                    {node.build.commit}
                  </span>
                )}
              </InfoRow>
              <InfoRow label={m.nodes_detail_config_version()}>
                <ConfigBadge
                  version={node.configVersion}
                  current={config.data?.configVersion}
                />
              </InfoRow>
              <InfoRow label={m.nodes_col_sandboxes()}>
                {reading === null
                  ? m.nodes_no_reading()
                  : m.nodes_sandboxes_cell({
                      active: reading.sandboxes.byState.active,
                      frozen: reading.sandboxes.byState.frozen,
                      total: reading.sandboxes.total,
                    })}
              </InfoRow>
              <InfoRow label={m.nodes_detail_swap_target()}>
                {reading !== null && reading.managedSwap === null
                  ? m.nodes_swap_unsupported()
                  : m.nodes_swap_target({ target: node.swapGb })}
              </InfoRow>
              <InfoRow label={m.nodes_detail_swap_active()}>
                {reading === null || reading.managedSwap === null
                  ? '—'
                  : reading.managedSwap.activeGb === node.swapGb
                    ? m.nodes_swap_managed({
                        active: reading.managedSwap.activeGb,
                      })
                    : `${m.nodes_swap_managed({ active: reading.managedSwap.activeGb })} · ${m.nodes_swap_reconciling()}`}
              </InfoRow>
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** 键值一行,工作台信息卡的同款解剖:左键右值,值 mono 截断。 */
function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 text-xs last:border-b-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono">{children}</dd>
    </div>
  );
}
