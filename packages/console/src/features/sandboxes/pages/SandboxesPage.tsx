import type { Sandbox, SandboxState } from '@dormice/shared';
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  PackageIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { destroySandbox } from '@/lib/api';
import { formatBytes, pctOf } from '@/lib/format';
import { queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { CreateSandboxDialog } from '../components/CreateSandboxDialog';
import { DestroySandboxButton } from '../components/DestroySandboxButton';
import { SandboxStateBadge } from '../components/SandboxStateBadge';
import { UpgradableBadge } from '../components/UpgradableBadge';
import { policyLine, STATE_LABELS, since } from '../format';
import {
  useFleetMetrics,
  useSandboxes,
  useSandboxImages,
} from '../hooks/useSandboxes';

const STATE_FILTERS: Array<SandboxState> = [
  'active',
  'frozen',
  'stopped',
  'archived',
  'restoring',
];

/** 可排序的列:字符串比较对 externalId 和 ISO 时间戳同样成立。 */
type SortKey = 'externalId' | 'lastActiveAt' | 'createdAt';
type Sort = { key: SortKey; dir: 1 | -1 };

/**
 * 资源列的一格:数值紧凑,细节挂 hover;占比过线换警示色,和指标 tab
 * 的 Meter 同一套阈值。value 为 null = 这行没被测到(没有容器可测)。
 */
function UsageCell({
  value,
  pct,
  title,
}: {
  value: string | null;
  pct: number;
  title?: string;
}) {
  if (value === null) {
    return <TableCell className="text-muted-foreground">—</TableCell>;
  }
  return (
    <TableCell
      className={cn(
        'tabular-nums',
        pct >= 90
          ? 'text-red-600 dark:text-red-400'
          : pct >= 75
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground',
      )}
      title={title}
    >
      {value}
    </TableCell>
  );
}

/**
 * 表头的排序按钮:点一下升序,再点反向。"空闲最久的是谁"不该靠肉眼
 * 扫一张会自己刷新的表。
 */
function SortableHead({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  sort: Sort | null;
  onSort: (key: SortKey) => void;
}) {
  const active = sort?.key === sortKey;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active && (
        <HugeiconsIcon
          icon={sort.dir === 1 ? ArrowUp01Icon : ArrowDown01Icon}
          className="size-3.5"
        />
      )}
    </button>
  );
}

/**
 * 批量销毁:逐个调用 destroySandbox(daemon 的 per-key 锁本来就是逐个
 * 裁决的,并发只是把失败搅在一起),结束后一次性汇报成败。
 */
function BulkDestroyButton({
  externalIds,
  onDone,
}: {
  externalIds: string[];
  onDone: () => void;
}) {
  const [pending, setPending] = useState(false);

  const destroyAll = async () => {
    setPending(true);
    const failures: string[] = [];
    for (const externalId of externalIds) {
      try {
        await destroySandbox(externalId);
      } catch {
        failures.push(externalId);
      }
    }
    setPending(false);
    void queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
    if (failures.length === 0) {
      toast.success(`已销毁  个沙箱`);
    } else {
      toast.error(`${failures.length} 个销毁失败:${failures.join('、')}`);
    }
    onDone();
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="destructive" size="sm" disabled={pending}>
            {pending && <Spinner />}
            销毁选中({externalIds.length})
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>销毁 {externalIds.length} 个沙箱?</AlertDialogTitle>
          <AlertDialogDescription>
            沙箱连同磁盘一起销毁,不可恢复。key 依然有效 — 下次 acquire
            会得到一个全新的空白沙箱。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>先留着</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={destroyAll}>
            销毁
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SandboxesPage() {
  const query = useSandboxes();
  const sandboxes = query.data?.sandboxes ?? [];
  // 资源快照批量拉(一个请求管全表);读不到就整列出 —,不挡列表本身。
  const fleet = useFleetMetrics();
  const metricsOf = useMemo(
    () =>
      new Map((fleet.data?.samples ?? []).map((s) => [s.externalId, s.sample])),
    [fleet.data],
  );
  // 镜像血统批量拉,同一口径:拉不到就不出标记,不挡列表。
  const images = useSandboxImages();
  const lineageOf = useMemo(
    () => new Map((images.data?.images ?? []).map((e) => [e.externalId, e])),
    [images.data],
  );
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | SandboxState>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort | null>(null);

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === 1 ? -1 : 1 }
        : { key, dir: 1 },
    );

  const filtered = useMemo(() => {
    const matched = sandboxes.filter(
      (sandbox) =>
        (stateFilter === 'all' || sandbox.state === stateFilter) &&
        (search === '' ||
          sandbox.externalId.toLowerCase().includes(search.toLowerCase())),
    );
    if (!sort) return matched;
    return [...matched].sort(
      (a, b) => a[sort.key].localeCompare(b[sort.key]) * sort.dir,
    );
  }, [sandboxes, stateFilter, search, sort]);

  // 选中集随现实收敛:被别处销毁的沙箱不该留在选中里撑数字。
  const selectedVisible = filtered.filter((s) => selected.has(s.externalId));
  const allVisibleSelected =
    filtered.length > 0 && selectedVisible.length === filtered.length;

  const toggleAll = () => {
    setSelected(
      allVisibleSelected
        ? new Set()
        : new Set(filtered.map((s) => s.externalId)),
    );
  };
  const toggleOne = (externalId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(externalId)) next.delete(externalId);
      else next.add(externalId);
      return next;
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">沙箱</h1>
          <p className="text-sm text-muted-foreground">
            账本里的全部沙箱,每 2 秒刷新 — 看着不会吵醒任何一个。
          </p>
        </div>
        <CreateSandboxDialog />
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
            placeholder="按 externalId 搜索"
          />
        </InputGroup>
        <NativeSelect
          aria-label="按状态筛选"
          value={stateFilter}
          onChange={(event) =>
            setStateFilter(event.target.value as 'all' | SandboxState)
          }
        >
          <NativeSelectOption value="all">全部状态</NativeSelectOption>
          {STATE_FILTERS.map((state) => (
            <NativeSelectOption key={state} value={state}>
              {STATE_LABELS[state]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="text-sm text-muted-foreground">
          {filtered.length} / {sandboxes.length} 个
        </span>
        {selectedVisible.length > 0 && (
          <div className="ml-auto">
            <BulkDestroyButton
              externalIds={selectedVisible.map((s) => s.externalId)}
              onDone={() => setSelected(new Set())}
            />
          </div>
        )}
      </div>

      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      )}

      {query.isSuccess && sandboxes.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={PackageIcon} />
            </EmptyMedia>
            <EmptyTitle>还没有沙箱</EmptyTitle>
            <EmptyDescription>
              在这里创建一个,或者用 SDK acquire — 两秒内都会出现在这张表里。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {query.isSuccess && sandboxes.length > 0 && filtered.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>没有匹配的沙箱</EmptyTitle>
            <EmptyDescription>换个关键词或状态试试。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {filtered.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="全选"
                    checked={allVisibleSelected}
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
                <TableHead>
                  <SortableHead
                    label="externalId"
                    sortKey="externalId"
                    sort={sort}
                    onSort={toggleSort}
                  />
                </TableHead>
                <TableHead>状态</TableHead>
                <TableHead>模板</TableHead>
                <TableHead>CPU</TableHead>
                <TableHead>内存</TableHead>
                <TableHead>磁盘</TableHead>
                <TableHead>
                  {/* 升序 = 最久没动的排最前:回收磁盘时先看这里。 */}
                  <SortableHead
                    label="空闲"
                    sortKey="lastActiveAt"
                    sort={sort}
                    onSort={toggleSort}
                  />
                </TableHead>
                <TableHead>生命周期策略</TableHead>
                <TableHead>
                  <SortableHead
                    label="存活"
                    sortKey="createdAt"
                    sort={sort}
                    onSort={toggleSort}
                  />
                </TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((sandbox: Sandbox) => (
                <TableRow
                  key={sandbox.sandboxId}
                  data-state={
                    selected.has(sandbox.externalId) ? 'selected' : undefined
                  }
                >
                  <TableCell>
                    <Checkbox
                      aria-label={`选中 ${sandbox.externalId}`}
                      checked={selected.has(sandbox.externalId)}
                      onCheckedChange={() => toggleOne(sandbox.externalId)}
                    />
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/sandboxes/$externalId"
                      params={{ externalId: sandbox.externalId }}
                      search={{ tab: 'overview' }}
                      className="font-mono font-medium hover:underline"
                    >
                      {sandbox.externalId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <SandboxStateBadge state={sandbox.state} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      {sandbox.template ?? '基础镜像'}
                      <UpgradableBadge
                        lineage={lineageOf.get(sandbox.externalId)}
                      />
                    </span>
                  </TableCell>
                  {(() => {
                    const m = metricsOf.get(sandbox.externalId);
                    if (!m) {
                      return (
                        <>
                          <UsageCell value={null} pct={0} />
                          <UsageCell value={null} pct={0} />
                          <UsageCell value={null} pct={0} />
                        </>
                      );
                    }
                    return (
                      <>
                        <UsageCell
                          value={`${Math.round(m.cpuUsedPct)}%`}
                          pct={m.cpuUsedPct / m.cpuCount}
                          title={`${m.cpuCount} 核 · 百分比按单核计`}
                        />
                        <UsageCell
                          value={formatBytes(m.memUsedBytes)}
                          pct={pctOf(m.memUsedBytes, m.memTotalBytes)}
                          title={`共 ${formatBytes(m.memTotalBytes)}`}
                        />
                        <UsageCell
                          value={formatBytes(m.diskUsedBytes)}
                          pct={pctOf(m.diskUsedBytes, m.diskTotalBytes)}
                          title={`名义 ${formatBytes(m.diskTotalBytes)}`}
                        />
                      </>
                    );
                  })()}
                  <TableCell
                    className="tabular-nums text-muted-foreground"
                    title={`最近活动:${new Date(sandbox.lastActiveAt).toLocaleString()}`}
                  >
                    {since(sandbox.lastActiveAt)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {policyLine(sandbox.policy)}
                  </TableCell>
                  <TableCell
                    className="tabular-nums text-muted-foreground"
                    title={`创建于:${new Date(sandbox.createdAt).toLocaleString()}`}
                  >
                    {since(sandbox.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DestroySandboxButton externalId={sandbox.externalId} />
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
