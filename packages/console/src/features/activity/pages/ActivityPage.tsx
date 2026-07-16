import type { ActivityKind } from '@dormice/shared';
import { Search01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { DataTable } from '@/components/DataTable';
import { FilterMenu } from '@/components/FilterMenu';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import {
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
 * 筛选是纯前端的:环一共就 1000 条,全在手里,没必要为过滤发明服务端
 * 参数。
 */
export function ActivityPage() {
  const { data, isPending, isError, error } = useActivity();
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | ActivityKind>('all');

  const events = data?.events ?? [];
  const filtered = useMemo(
    () =>
      events.filter(
        (event) =>
          (kindFilter === 'all' || event.kind === kindFilter) &&
          (search === '' ||
            (event.sandboxName ?? '')
              .toLowerCase()
              .includes(search.toLowerCase())),
      ),
    [events, kindFilter, search],
  );

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">活动</h1>
        <p className="text-sm text-muted-foreground">
          账本的历史:谁被创建、冻结、停止、销毁,对账修了什么。保留最近 1000
          条,更老的自然滚出。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="w-64">
          <InputGroupAddon>
            <HugeiconsIcon
              icon={Search01Icon}
              className="size-4 text-muted-foreground"
            />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="按名称搜索"
          />
        </InputGroup>
        <FilterMenu
          label="事件"
          value={kindFilter === 'all' ? '' : kindFilter}
          options={(
            Object.entries(ACTIVITY_KIND_LABELS) as Array<
              [ActivityKind, string]
            >
          ).map(([kind, label]) => ({ value: kind, label }))}
          onChange={(value) =>
            setKindFilter(value === '' ? 'all' : (value as ActivityKind))
          }
        />
        <span className="text-sm text-muted-foreground">
          {filtered.length} / {events.length} 条
        </span>
      </div>

      {isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> 读取活动
        </div>
      ) : isError ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>读取失败</EmptyTitle>
            <EmptyDescription>{error.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : events.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>还没有活动</EmptyTitle>
            <EmptyDescription>
              创建一个沙箱,它的整个生命周期就会出现在这里。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : filtered.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>没有匹配的事件</EmptyTitle>
            <EmptyDescription>换个关键词或事件类型试试。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        // 环形记录上限 1000 条,是全站最长的表 — 限高框内滚,表头吸顶。
        <DataTable containerClassName="max-h-[70vh]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">时间</TableHead>
              <TableHead className="w-28">事件</TableHead>
              <TableHead className="w-40">名称</TableHead>
              <TableHead>详情</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((event) => (
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
                  {event.sandboxName ? (
                    <Link
                      to="/sandboxes/$name"
                      params={{ name: event.sandboxName }}
                      search={{ tab: 'overview' as const }}
                      className="font-mono hover:underline"
                    >
                      {event.sandboxName}
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
        </DataTable>
      )}
    </>
  );
}
