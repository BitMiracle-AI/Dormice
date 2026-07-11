import type { ActivityKind } from '@dormice/shared';
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

/** 事件的中文名 — 与 wire 上的 kind 一比一,这里是唯一的翻译点。 */
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  created: '创建',
  woken: '唤醒',
  frozen: '冻结',
  stopped: '停止',
  rebuilt: '重建',
  released: '释放',
  'expired-killed': '到期销毁',
  archived: '归档',
  'restore-started': '开始恢复',
  restored: '恢复完成',
  'restore-failed': '恢复失败',
  reconciled: '对账修复',
  'daemon-started': 'daemon 启动',
};

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
  'expired-killed':
    'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  archived:
    'border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  'restore-started':
    'border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  restored:
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  'restore-failed':
    'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  reconciled:
    'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  'daemon-started': 'border-border bg-muted text-muted-foreground',
};

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
      )}
    </>
  );
}
