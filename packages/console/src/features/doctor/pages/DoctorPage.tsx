import {
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  MinusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import { SampleDataBadge } from '@/components/SampleDataBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { since } from '@/features/sandboxes/format';
import { MOCK_PAGES_ENABLED } from '@/lib/mock';
import { cn } from '@/lib/utils';
import { type DoctorStatus, SAMPLE_DOCTOR } from '../fixtures';

const STATUS_META: Record<
  DoctorStatus,
  {
    icon: NonNullable<HugeiconsProps['icon']>;
    className: string;
    label: string;
  }
> = {
  pass: {
    icon: CheckmarkCircle02Icon,
    className: 'text-emerald-600 dark:text-emerald-400',
    label: '通过',
  },
  warn: {
    icon: Alert02Icon,
    className: 'text-amber-600 dark:text-amber-400',
    label: '警告',
  },
  fail: {
    icon: CancelCircleIcon,
    className: 'text-red-600 dark:text-red-400',
    label: '失败',
  },
  skip: {
    icon: MinusSignIcon,
    className: 'text-muted-foreground',
    label: '跳过',
  },
};

/**
 * `dor doctor` 的浏览器版:同一套只读检查(规则单一来源在 CLI),回答
 * "这台机器能不能跑 daemon"。生产里等 /runDoctor 端点落地 — 它要在
 * daemon 里起真探针容器,不是纯前端能演的;眼下示例数据定版式。
 */
export function DoctorPage() {
  if (!MOCK_PAGES_ENABLED) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>尚未接入</EmptyTitle>
          <EmptyDescription>
            浏览器里跑体检要等 runDoctor 端点落地;现在请在主机上执行{' '}
            <code className="font-mono">dor doctor</code>。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const report = SAMPLE_DOCTOR;
  const counts = report.checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0, skip: 0 } as Record<DoctorStatus, number>,
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-medium">
          体检 <SampleDataBadge />
        </h1>
        <Tooltip>
          <TooltipTrigger
            render={
              <span>
                <Button size="sm" disabled>
                  重新体检
                </Button>
              </span>
            }
          />
          <TooltipContent>接入 runDoctor 端点后可用</TooltipContent>
        </Tooltip>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge
          variant="outline"
          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        >
          {counts.pass} 通过
        </Badge>
        {counts.warn > 0 && (
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          >
            {counts.warn} 警告
          </Badge>
        )}
        {counts.fail > 0 && (
          <Badge
            variant="outline"
            className="border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
          >
            {counts.fail} 失败
          </Badge>
        )}
        <span className="text-muted-foreground">
          {since(report.ranAt)}前跑完,耗时{' '}
          {(report.durationMs / 1000).toFixed(1)}s(含 3 个真容器探针)
        </span>
      </div>

      <Card>
        <CardContent>
          <ul className="divide-y">
            {report.checks.map((check) => {
              const meta = STATUS_META[check.status];
              return (
                <li key={check.id} className="flex items-start gap-3 py-3">
                  <HugeiconsIcon
                    icon={meta.icon}
                    className={cn('mt-0.5 size-4 shrink-0', meta.className)}
                    strokeWidth={2}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{check.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {check.id}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {check.detail}
                    </p>
                    {check.fix && (
                      <p className={cn('mt-1 text-sm', meta.className)}>
                        修复:{check.fix}
                      </p>
                    )}
                  </div>
                  <span className={cn('text-xs', meta.className)}>
                    {meta.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
