import { Clock01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useActivity } from '@/features/activity/hooks/useActivity';
import {
  ACTIVITY_KIND_LABELS,
  ACTIVITY_KIND_STYLES,
} from '@/features/activity/kinds';
import { cn } from '@/lib/utils';
import { since } from '../format';

/**
 * 「我的沙箱昨晚为什么停了」— 活动环里只属于这个沙箱的那几行。纯前端
 * 过滤:活动事件本来就带 externalId,不发明新端点;按环形表上限(1000)
 * 拉取,把这个沙箱的事件尽量捞全,再老的已经滚出环了。
 */
export function HistoryPanel({ externalId }: { externalId: string }) {
  const { data, isPending, isError, error } = useActivity(1000);
  const events = (data?.events ?? []).filter(
    (event) => event.externalId === externalId,
  );

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> 读取历史…
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
  if (events.length === 0) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={Clock01Icon} />
          </EmptyMedia>
          <EmptyTitle>最近没有这个沙箱的事件</EmptyTitle>
          <EmptyDescription>
            活动环只保留全局最近 1000 条 — 它更早的历史已经滚出去了。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">时间</TableHead>
              <TableHead className="w-28">事件</TableHead>
              <TableHead>详情</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <TableRow key={event.id}>
                <TableCell
                  className="tabular-nums text-muted-foreground"
                  title={new Date(event.at).toLocaleString()}
                >
                  {since(event.at)}前
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn(
                      'font-medium',
                      ACTIVITY_KIND_STYLES[event.kind],
                    )}
                  >
                    {ACTIVITY_KIND_LABELS[event.kind]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {event.detail}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-sm text-muted-foreground">
        销毁沙箱后 key 会重新可用 — 这里可能同时看到新旧两代沙箱的事件。
      </p>
    </div>
  );
}
