import type { ActivityKind } from '@dormice/shared';
import { Search01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { DataTable } from '@/components/DataTable';
import { FilterMenu } from '@/components/FilterMenu';
import { paginate, TablePager } from '@/components/TablePager';
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
import { useApiKeys } from '@/features/api-keys/hooks/useApiKeys';
import { since } from '@/features/sandboxes/format';
import { cn } from '@/lib/utils';
import { actorLabel } from '../actors';
import { useActivity } from '../hooks/useActivity';
import { ACTIVITY_KIND_LABELS, ACTIVITY_KIND_STYLES } from '../kinds';

const PAGE_SIZE = 50;

/**
 * 筛选器里 actor=null(系统)的哨兵值。词表是封闭的('env-token' /
 * 'console' / 'apikey:<id>'),裸串 'system' 永不与真实 actor 相撞。
 */
const SYSTEM_ACTOR_FILTER = 'system';

/**
 * 「我不在的时候发生了什么」:daemon 每一次生命周期动作(创建、降温、
 * 唤醒、销毁)和对账修复的有界环形记录 — 事件写在动作发生处,这里只读。
 * 筛选是纯前端的:环一共就 1000 条,全在手里,没必要为过滤发明服务端
 * 参数。操作者列回答事故响应的第一问(「这把 key 干了什么」):按 kind
 * 之外再按 actor 筛,就是那把 key 的爆炸半径。
 */
export function ActivityPage() {
  const { data, isPending, isError, error } = useActivity();
  // 只为把 apikey:<id> 翻译回名字;密钥页共用一份缓存。
  const apiKeys = useApiKeys().data?.apiKeys;
  // ?sandbox= 是沙箱工作台「查看全部」带来的预筛,只当搜索框的一次性
  // 种子 — 落地后搜索框归用户,不做双向同步。
  const { sandbox: sandboxParam } = useSearch({ from: '/_app/activity' });
  const [search, setSearch] = useState(() => sandboxParam ?? '');
  const [kindFilter, setKindFilter] = useState<'all' | ActivityKind>('all');
  const [actorFilter, setActorFilter] = useState('');
  const [page, setPage] = useState(1);

  const events = data?.events ?? [];
  const filtered = useMemo(
    () =>
      events.filter(
        (event) =>
          (kindFilter === 'all' || event.kind === kindFilter) &&
          (actorFilter === '' ||
            (actorFilter === SYSTEM_ACTOR_FILTER
              ? event.actor === null
              : event.actor === actorFilter)) &&
          (search === '' ||
            (event.sandboxName ?? '')
              .toLowerCase()
              .includes(search.toLowerCase())),
      ),
    [events, kindFilter, actorFilter, search],
  );
  // 选项来自数据里实际出现过的操作者 — 不虚构没干过活的候选。
  const actorOptions = useMemo(() => {
    const seen = new Set(events.map((event) => event.actor));
    return [...seen].map((actor) => ({
      value: actor ?? SYSTEM_ACTOR_FILTER,
      label: actorLabel(actor, apiKeys),
    }));
  }, [events, apiKeys]);
  const { rows, safePage, pageCount } = paginate(filtered, page, PAGE_SIZE);

  return (
    // openasi 列表页版式(2026-07-16 用户拍板):限宽居中、表格吃掉剩余
    // 高度框内滚、分页条钉底。
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
      <header className="shrink-0">
        <h1 className="text-xl font-medium">活动</h1>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <InputGroup className="w-64">
          <InputGroupAddon>
            <HugeiconsIcon
              icon={Search01Icon}
              className="size-4 text-muted-foreground"
            />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
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
          onChange={(value) => {
            setKindFilter(value === '' ? 'all' : (value as ActivityKind));
            setPage(1);
          }}
        />
        <FilterMenu
          label="操作者"
          value={actorFilter}
          options={actorOptions}
          onChange={(value) => {
            setActorFilter(value);
            setPage(1);
          }}
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
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyTitle>读取失败</EmptyTitle>
            <EmptyDescription>{error.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : events.length === 0 ? (
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyTitle>还没有活动</EmptyTitle>
            <EmptyDescription>
              创建一个沙箱,它的整个生命周期就会出现在这里。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : filtered.length === 0 ? (
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyTitle>没有匹配的事件</EmptyTitle>
            <EmptyDescription>换个关键词或事件类型试试。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        // 环形记录上限 1000 条,是全站最长的表 — fill 框内滚,表头吸顶。
        <DataTable fill>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">时间</TableHead>
              <TableHead className="w-28">事件</TableHead>
              <TableHead className="w-40">名称</TableHead>
              <TableHead className="w-32">操作者</TableHead>
              <TableHead>详情</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((event) => (
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
                      className="font-mono hover:underline"
                    >
                      {event.sandboxName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell
                  className={cn(
                    event.actor === null && 'text-muted-foreground',
                  )}
                >
                  {actorLabel(event.actor, apiKeys)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {event.detail}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}

      {!isPending && !isError && filtered.length > 0 && (
        <TablePager
          page={safePage}
          pageCount={pageCount}
          total={filtered.length}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
