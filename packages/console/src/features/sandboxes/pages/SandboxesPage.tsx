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
import { releaseSandbox } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { CreateSandboxDialog } from '../components/CreateSandboxDialog';
import { ReleaseSandboxButton } from '../components/ReleaseSandboxButton';
import { SandboxStateBadge } from '../components/SandboxStateBadge';
import { policyLine, STATE_LABELS, since } from '../format';
import { useSandboxes } from '../hooks/useSandboxes';

const STATE_FILTERS: Array<SandboxState> = [
  'active',
  'frozen',
  'stopped',
  'archived',
  'restoring',
];

/** 可排序的列:字符串比较对 userKey 和 ISO 时间戳同样成立。 */
type SortKey = 'userKey' | 'lastActiveAt' | 'createdAt';
type Sort = { key: SortKey; dir: 1 | -1 };

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
 * 批量释放:逐个调用 releaseSandbox(daemon 的 per-key 锁本来就是逐个
 * 裁决的,并发只是把失败搅在一起),结束后一次性汇报成败。
 */
function BulkReleaseButton({
  userKeys,
  onDone,
}: {
  userKeys: string[];
  onDone: () => void;
}) {
  const [pending, setPending] = useState(false);

  const releaseAll = async () => {
    setPending(true);
    const failures: string[] = [];
    for (const userKey of userKeys) {
      try {
        await releaseSandbox(userKey);
      } catch {
        failures.push(userKey);
      }
    }
    setPending(false);
    void queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
    if (failures.length === 0) {
      toast.success(`已释放 ${userKeys.length} 个沙箱`);
    } else {
      toast.error(`${failures.length} 个释放失败:${failures.join('、')}`);
    }
    onDone();
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="destructive" size="sm" disabled={pending}>
            {pending && <Spinner />}
            释放选中({userKeys.length})
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>释放 {userKeys.length} 个沙箱?</AlertDialogTitle>
          <AlertDialogDescription>
            沙箱连同磁盘一起销毁,不可恢复。key 依然有效 — 下次 acquire
            会得到一个全新的空白沙箱。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>先留着</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={releaseAll}>
            释放
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SandboxesPage() {
  const query = useSandboxes();
  const sandboxes = query.data?.sandboxes ?? [];
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
          sandbox.userKey.toLowerCase().includes(search.toLowerCase())),
    );
    if (!sort) return matched;
    return [...matched].sort(
      (a, b) => a[sort.key].localeCompare(b[sort.key]) * sort.dir,
    );
  }, [sandboxes, stateFilter, search, sort]);

  // 选中集随现实收敛:被别处释放的沙箱不该留在选中里撑数字。
  const selectedVisible = filtered.filter((s) => selected.has(s.userKey));
  const allVisibleSelected =
    filtered.length > 0 && selectedVisible.length === filtered.length;

  const toggleAll = () => {
    setSelected(
      allVisibleSelected ? new Set() : new Set(filtered.map((s) => s.userKey)),
    );
  };
  const toggleOne = (userKey: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userKey)) next.delete(userKey);
      else next.add(userKey);
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
            placeholder="按 userKey 搜索"
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
            <BulkReleaseButton
              userKeys={selectedVisible.map((s) => s.userKey)}
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
                    label="userKey"
                    sortKey="userKey"
                    sort={sort}
                    onSort={toggleSort}
                  />
                </TableHead>
                <TableHead>状态</TableHead>
                <TableHead>模板</TableHead>
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
                    selected.has(sandbox.userKey) ? 'selected' : undefined
                  }
                >
                  <TableCell>
                    <Checkbox
                      aria-label={`选中 ${sandbox.userKey}`}
                      checked={selected.has(sandbox.userKey)}
                      onCheckedChange={() => toggleOne(sandbox.userKey)}
                    />
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/sandboxes/$userKey"
                      params={{ userKey: sandbox.userKey }}
                      search={{ tab: 'overview' }}
                      className="font-mono font-medium hover:underline"
                    >
                      {sandbox.userKey}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <SandboxStateBadge state={sandbox.state} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {sandbox.template ?? '基础镜像'}
                  </TableCell>
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
                    <ReleaseSandboxButton userKey={sandbox.userKey} />
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
