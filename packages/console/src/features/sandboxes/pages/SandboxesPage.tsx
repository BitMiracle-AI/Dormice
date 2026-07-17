import type { Sandbox, SandboxState } from '@dormice/shared';
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Copy01Icon,
  Delete02Icon,
  MoreVerticalIcon,
  PackageIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/DataTable';
import { FilterMenu } from '@/components/FilterMenu';
import { Meter } from '@/components/Meter';
import { paginate, TablePager } from '@/components/TablePager';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Spinner } from '@/components/ui/spinner';
import {
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
import { DestroySandboxDialog } from '../components/DestroySandboxButton';
import { SandboxStateBadge } from '../components/SandboxStateBadge';
import { UpgradableBadge } from '../components/UpgradableBadge';
import { STATE_LABELS, since } from '../format';
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

const PAGE_SIZE = 50;

/** 可排序的列:字符串比较对 name 和 ISO 时间戳同样成立。 */
type SortKey = 'name' | 'createdAt' | 'lastActiveAt';
type Sort = { key: SortKey; dir: 1 | -1 };

/**
 * 一个沙箱的标签摊平成 "key=value" 串,供筛选。标签列刻意不设
 * (2026-07-17 用户拍板):标签的用途是分组筛选,不是逐行阅读 —
 * chips 会 flex-wrap 撑高行,单个沙箱的标签去详情页看。
 */
function labelPairs(sandbox: Sandbox): string[] {
  return Object.entries(sandbox.metadata).map(
    ([key, value]) => `${key}=${value}`,
  );
}

/**
 * 上限一侧的字节数:去掉小数尾零 — 上限几乎都是整数,「4.00 GiB」
 * 的尾零是噪音;用量一侧保留 formatBytes 原样,精度在那儿是信息。
 */
function formatCap(bytes: number): string {
  return formatBytes(bytes)
    .replace(/(\.\d*?)0+(?= )/, '$1')
    .replace(/\.(?= )/, '');
}

/**
 * 资源列的一格:写成「用量 / 上限」— 不带分母的数字没有信息量,
 * 1.2 GiB 对 2 GiB 的沙箱是快满,对 8 GiB 的是很空。占比过线换警示色,
 * 和指标 tab 的 Meter 同一套阈值。value 为 null = 这行没被测到
 * (没有容器可测)。
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
    return (
      <TableCell className="text-right text-muted-foreground">—</TableCell>
    );
  }
  return (
    <TableCell
      className={cn(
        'text-right tabular-nums',
        pct >= 90
          ? 'text-red-600 dark:text-red-400'
          : pct >= 75
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground',
      )}
      title={title}
    >
      {value}
      {/* 迷你条:数字给精度,条给一眼的量感。宽度钉死不随列宽漂 —
          三列的条一样长,长短才可比。 */}
      <div className="mt-1 ml-auto w-16">
        <Meter pct={pct} />
      </div>
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
 * 行操作收进「⋯」菜单(风格参考 openasi 表格,2026-07-15):每行一个
 * 安静的 ghost 图标,不是一排常驻按钮。销毁的确认弹窗挂在菜单外 —
 * 菜单关闭即卸载,弹窗放里面会跟着消失。
 */
function SandboxRowMenu({ name }: { name: string }) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${name} 的操作`}
            >
              <HugeiconsIcon icon={MoreVerticalIcon} />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={async () => {
              await navigator.clipboard.writeText(name);
              toast.success('名称已复制');
            }}
          >
            <HugeiconsIcon icon={Copy01Icon} />
            复制名称
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} />
            销毁
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DestroySandboxDialog
        name={name}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
      />
    </>
  );
}

/**
 * 批量销毁:逐个调用 destroySandbox(daemon 的 per-key 锁本来就是逐个
 * 裁决的,并发只是把失败搅在一起),结束后一次性汇报成败。
 */
function BulkDestroyButton({
  names,
  onDone,
}: {
  names: string[];
  onDone: () => void;
}) {
  const [pending, setPending] = useState(false);

  const destroyAll = async () => {
    setPending(true);
    const failures: string[] = [];
    for (const name of names) {
      try {
        await destroySandbox(name);
      } catch {
        failures.push(name);
      }
    }
    setPending(false);
    void queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
    if (failures.length === 0) {
      toast.success(`已销毁 ${names.length} 个沙箱`);
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
            销毁选中({names.length})
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>销毁 {names.length} 个沙箱?</AlertDialogTitle>
          <AlertDialogDescription>
            沙箱连同磁盘一起销毁,不可恢复。名字依然可用 — 下次用同名 acquire
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
      new Map(
        (fleet.data?.samples ?? []).map((s) => [s.sandboxName, s.sample]),
      ),
    [fleet.data],
  );
  // 镜像血统批量拉,同一口径:拉不到就不出标记,不挡列表。
  const images = useSandboxImages();
  const lineageOf = useMemo(
    () => new Map((images.data?.images ?? []).map((e) => [e.sandboxName, e])),
    [images.data],
  );
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | SandboxState>('all');
  // 值是 "key=value" 串,'' = 全部。选项从舰队现有标签去重而来 —
  // 分组不是实体,就是按标签筛,所以没有可维护的"组列表"要管。
  const [metadataFilter, setMetadataFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort | null>(null);
  // 分页是纯前端的(列表整份在手里);筛选变化回第一页,排序不回 —
  // 排序改的是全序不是集合。
  const [page, setPage] = useState(1);

  const metadataOptions = useMemo(() => {
    const pairs = new Set(sandboxes.flatMap(labelPairs));
    return [...pairs].sort().map((pair) => ({ value: pair, label: pair }));
  }, [sandboxes]);

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
        (metadataFilter === '' ||
          labelPairs(sandbox).includes(metadataFilter)) &&
        (search === '' ||
          sandbox.name.toLowerCase().includes(search.toLowerCase())),
    );
    if (!sort) return matched;
    return [...matched].sort(
      (a, b) => a[sort.key].localeCompare(b[sort.key]) * sort.dir,
    );
  }, [sandboxes, stateFilter, metadataFilter, search, sort]);

  const { rows, safePage, pageCount } = paginate(filtered, page, PAGE_SIZE);

  // 选中集随现实收敛:被别处销毁的沙箱不该留在选中里撑数字。
  const selectedVisible = filtered.filter((s) => selected.has(s.name));
  const allVisibleSelected =
    filtered.length > 0 && selectedVisible.length === filtered.length;

  const toggleAll = () => {
    setSelected(
      allVisibleSelected ? new Set() : new Set(filtered.map((s) => s.name)),
    );
  };
  const toggleOne = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    // openasi 列表页版式(2026-07-16 用户拍板):限宽居中、页头一行、
    // 表格吃掉剩余高度框内滚、分页条钉底。h-full 接住外壳锁定的视口高。
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-medium">沙箱</h1>
        <CreateSandboxDialog />
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
            placeholder="按 name 搜索"
          />
        </InputGroup>
        <FilterMenu
          label="状态"
          value={stateFilter === 'all' ? '' : stateFilter}
          options={STATE_FILTERS.map((state) => ({
            value: state,
            label: STATE_LABELS[state],
          }))}
          onChange={(value) => {
            setStateFilter(value === '' ? 'all' : (value as SandboxState));
            setPage(1);
          }}
        />
        {metadataOptions.length > 0 && (
          <FilterMenu
            label="标签"
            value={metadataFilter}
            options={metadataOptions}
            onChange={(value) => {
              setMetadataFilter(value);
              setPage(1);
            }}
          />
        )}
        <span className="text-sm text-muted-foreground">
          {filtered.length} / {sandboxes.length} 个
        </span>
        {selectedVisible.length > 0 && (
          <div className="ml-auto">
            <BulkDestroyButton
              names={selectedVisible.map((s) => s.name)}
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
        <Empty className="flex-1 border border-dashed">
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
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyTitle>没有匹配的沙箱</EmptyTitle>
            <EmptyDescription>换个关键词或状态试试。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {filtered.length > 0 && (
        // fill:表格占满剩余高度框内滚,表头吸顶 — 列名滚不丢。
        <DataTable fill>
          <TableHeader>
            <TableRow>
              <TableHead className="w-0">
                <Checkbox
                  aria-label="全选"
                  checked={allVisibleSelected}
                  onCheckedChange={toggleAll}
                />
              </TableHead>
              <TableHead>
                <SortableHead
                  label="名称"
                  sortKey="name"
                  sort={sort}
                  onSort={toggleSort}
                />
              </TableHead>
              <TableHead>状态</TableHead>
              <TableHead>模板</TableHead>
              <TableHead className="text-right">CPU</TableHead>
              <TableHead className="text-right">内存</TableHead>
              <TableHead className="text-right">磁盘</TableHead>
              <TableHead>
                <SortableHead
                  label="创建"
                  sortKey="createdAt"
                  sort={sort}
                  onSort={toggleSort}
                />
              </TableHead>
              <TableHead>
                {/* 升序 = 最久没动的排最前:回收磁盘时先看这里 — 生命
                    周期策略从最后活动起算,这列才是"谁快被降温"的信号。
                    「策略」列刻意不设(2026-07-17 版式取舍):低频配置、
                    还是唯一会折行撑高行的列,归详情页。全表单行,不横滚。 */}
                <SortableHead
                  label="空闲"
                  sortKey="lastActiveAt"
                  sort={sort}
                  onSort={toggleSort}
                />
              </TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((sandbox: Sandbox) => (
              <TableRow
                key={sandbox.id}
                data-state={selected.has(sandbox.name) ? 'selected' : undefined}
              >
                <TableCell>
                  <Checkbox
                    aria-label={`选中 ${sandbox.name}`}
                    checked={selected.has(sandbox.name)}
                    onCheckedChange={() => toggleOne(sandbox.name)}
                  />
                </TableCell>
                <TableCell>
                  <Link
                    to="/sandboxes/$name"
                    params={{ name: sandbox.name }}
                    search={{ tab: 'overview' }}
                    className="font-mono font-medium hover:underline"
                  >
                    {sandbox.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <SandboxStateBadge state={sandbox.state} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    {/* 链接指向模板列表页(没有逐模板详情页);基础镜像
                        不是模板,没有可去处,保持纯文本。 */}
                    {sandbox.template ? (
                      <Link
                        to="/templates"
                        className="hover:text-foreground hover:underline"
                      >
                        {sandbox.template}
                      </Link>
                    ) : (
                      '基础镜像'
                    )}
                    <UpgradableBadge lineage={lineageOf.get(sandbox.name)} />
                  </span>
                </TableCell>
                {(() => {
                  const m = metricsOf.get(sandbox.name);
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
                        value={`${Math.round(m.cpuUsedPct)}% / ${m.cpuCount} 核`}
                        pct={m.cpuUsedPct / m.cpuCount}
                        title="百分比按单核计,多核可超 100%"
                      />
                      <UsageCell
                        value={`${formatBytes(m.memUsedBytes)} / ${formatCap(m.memTotalBytes)}`}
                        pct={pctOf(m.memUsedBytes, m.memTotalBytes)}
                      />
                      <UsageCell
                        value={`${formatBytes(m.diskUsedBytes)} / ${formatCap(m.diskTotalBytes)}`}
                        pct={pctOf(m.diskUsedBytes, m.diskTotalBytes)}
                        title="上限是名义配额:稀疏镜像,未写入不占宿主盘"
                      />
                    </>
                  );
                })()}
                {/* 带「前」:光秃的时长会被读成存活状态;空闲列不带 —
                    表头已说明它是一段仍在计数的时长。 */}
                <TableCell
                  className="tabular-nums text-muted-foreground"
                  title={`创建于:${new Date(sandbox.createdAt).toLocaleString()}`}
                >
                  {since(sandbox.createdAt)}前
                </TableCell>
                <TableCell
                  className="tabular-nums text-muted-foreground"
                  title={`最近活动:${new Date(sandbox.lastActiveAt).toLocaleString()}`}
                >
                  {since(sandbox.lastActiveAt)}
                </TableCell>
                <TableCell className="text-right">
                  <SandboxRowMenu name={sandbox.name} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}

      {filtered.length > 0 && (
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
