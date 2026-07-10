import { Link } from '@tanstack/react-router';
import { SampleDataBadge } from '@/components/SampleDataBadge';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { since } from '@/features/sandboxes/format';
import { MOCK_PAGES_ENABLED } from '@/lib/mock';
import { cn } from '@/lib/utils';
import {
  ACTIVITY_KIND_LABELS,
  type ActivityKind,
  SAMPLE_ACTIVITY,
} from '../fixtures';

// 事件色与沙箱状态徽章同一色系:落到哪个状态就穿哪个颜色。
const KIND_STYLES: Record<ActivityKind, string> = {
  created:
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  woken:
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  frozen: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  stopped: 'border-border bg-muted text-muted-foreground',
  rebuilt:
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  released: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  reconciled:
    'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  'expired-killed':
    'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
};

/**
 * 「我不在的时候发生了什么」。生产里等 /listActivity 落地(账本迁移处
 * 单点埋点 + 有界环形表);眼下用示例数据把版式定下来,生产构建整页隐藏。
 */
export function ActivityPage() {
  if (!MOCK_PAGES_ENABLED) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>尚未接入</EmptyTitle>
          <EmptyDescription>
            活动流等 listActivity 端点落地后可用。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            活动 <SampleDataBadge />
          </h1>
          <p className="text-sm text-muted-foreground">
            账本的历史:谁被创建、冻结、停止、销毁,对账修了什么。 将来自
            transition() 单点埋点的有界环形记录。
          </p>
        </div>
      </div>

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
            {SAMPLE_ACTIVITY.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="tabular-nums text-muted-foreground">
                  {since(event.at)}前
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn('font-medium', KIND_STYLES[event.kind])}
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
    </>
  );
}
