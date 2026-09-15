import type { NodeView } from '@dormice/shared';
import { Badge } from '@/components/ui/badge';
import { ago } from '@/features/sandboxes/format';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages';

/**
 * 可达/不可达:网关的裁决(两个自报间隔内报到过),这里只显示。点的
 * 颜色与沙箱五态的点同一套语言;最后报到时刻挂在 title 里。
 */
export function ReachableBadge({ node }: { node: NodeView }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm"
      title={
        node.lastCheckInAt === null
          ? m.nodes_never_checked_in()
          : m.nodes_last_check_in({ ago: ago(node.lastCheckInAt) })
      }
    >
      <span
        className={cn(
          'size-2 rounded-full',
          node.reachable ? 'bg-emerald-500' : 'bg-red-500',
        )}
      />
      {node.reachable ? m.nodes_reachable() : m.nodes_unreachable()}
    </span>
  );
}

/**
 * 配置漂移标记:节点报的版本对网关当前版本(getConfig.configVersion)。
 * 相等=已同步;落后=琥珀,并说落后几版(下一拍就拉齐,一直落后是那台
 * 应用不上);null=还没有副本,节点在拿到第一份之前不开门。网关版本还
 * 没读到时只显示节点自报的数字,不猜。
 */
export function ConfigBadge({
  version,
  current,
}: {
  version: number | null;
  current: number | undefined;
}) {
  if (version === null) {
    return (
      <Badge variant="secondary" title={m.nodes_config_none_hint()}>
        {m.nodes_config_none()}
      </Badge>
    );
  }
  if (current === undefined || version > current) {
    return <span className="tabular-nums">v{version}</span>;
  }
  if (version === current) {
    return (
      <Badge variant="outline" className="font-normal">
        {m.nodes_config_synced()}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-transparent bg-amber-500/10 font-medium text-amber-600 dark:text-amber-400"
      title={`v${version} → v${current}`}
    >
      {m.nodes_config_behind({ n: current - version })}
    </Badge>
  );
}
