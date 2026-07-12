import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
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
import { since } from '@/features/sandboxes/format';
import { cn } from '@/lib/utils';
import { useActivity } from '../hooks/useActivity';
import { ACTIVITY_KIND_LABELS, ACTIVITY_KIND_STYLES } from '../kinds';

/**
 * 「我不在的时候发生了什么」:daemon 每一次生命周期动作(创建、降温、
 * 唤醒、销毁)和对账修复的有界环形记录 — 事件写在动作发生处,这里只读。
 */
export function ActivityPage() {
  const { data, isPending, isError, error } = useActivity();

  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">活动</h1>
        <p className="text-sm text-muted-foreground">
          账本的历史:谁被创建、冻结、停止、销毁,对账修了什么。保留最近 1000
          条,更老的自然滚出。
        </p>
      </div>

      {isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> 读取活动…
        </div>
      ) : isError ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>读取失败</EmptyTitle>
            <EmptyDescription>{error.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : data.events.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>还没有活动</EmptyTitle>
            <EmptyDescription>
              创建一个沙箱,它的整个生命周期就会出现在这里。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">时间</TableHead>
                <TableHead className="w-28">事件</TableHead>
                <TableHead className="w-40">userKey</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell
                    className="tabular-nums text-muted-foreground"
                    // 相对时间好扫读,绝对时间才对得上日志 — hover 给后者。
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
                  <TableCell>
                    {event.userKey ? (
                      <Link
                        to="/sandboxes/$userKey"
                        params={{ userKey: event.userKey }}
                        search={{ tab: 'overview' as const }}
                        className="font-mono hover:underline"
                      >
                        {event.userKey}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {event.detail}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
