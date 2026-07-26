import type { Sandbox, SandboxState } from '@dormice/shared';
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Copy01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
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
import { m } from '@/paraglide/messages';
import { CreateSandboxDialog } from '../components/CreateSandboxDialog';
import { DestroySandboxDialog } from '../components/DestroySandboxButton';
import { EditPolicyDialog } from '../components/EditPolicyDialog';
import { SandboxStateBadge } from '../components/SandboxStateBadge';
import { UpgradableBadge } from '../components/UpgradableBadge';
import { ago, stateLabel } from '../format';
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
 * 资源列的一格:Meter 条是主角,「用量 / 上限」整行 text-xs 当精度注脚
 * (2026-07-18 用户拍板,主次对调) — 扫表时读的是条的长短与颜色,数字
 * 是停下来核对时才看的。数字列因此瘦身,省下的宽度归名称列。占比过线
 * 数字换警示色,和 Meter 同一套阈值同一套色。value 为 null = 这行没被
 * 测到(没有容器可测)。
 */
function UsageCell({
  value,
  cap,
  pct,
  title,
}: {
  value: string | null;
  cap?: string;
  pct: number;
  title?: string;
}) {
  if (value === null) {
    return (
      <TableCell className="text-right text-xs text-muted-foreground">
        —
      </TableCell>
    );
  }
  return (
    <TableCell
      className={cn(
        'text-right text-xs tabular-nums',
        pct >= 90
          ? 'text-red-600 dark:text-red-400'
          : pct >= 75
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground',
      )}
      title={title}
    >
      {value}
      {cap && <> / {cap}</>}
      {/* 条的宽度钉死不随列宽漂 — 三列的条一样长,长短才可比。 */}
      <div className="mt-1 ml-auto w-24">
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
              size="icon"
              aria-label={m.sandboxes_row_actions_aria({ name })}
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} className="size-5" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className="font-medium"
            onClick={async () => {
              await navigator.clipboard.writeText(name);
              toast.success(m.sandboxes_name_copied());
            }}
          >
            <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
            {m.sandboxes_copy_name()}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            className="font-medium"
            onClick={() => setConfirmOpen(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {m.sandboxes_destroy()}
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
      toast.success(m.sandboxes_destroyed_count({ n: names.length }));
    } else {
      toast.error(
        m.sandboxes_destroy_failed_count({
          n: failures.length,
          names: failures.join(m.sandboxes_name_separator()),
        }),
      );
    }
    onDone();
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="destructive" size="sm" disabled={pending}>
            {pending && <Spinner />}
            {m.sandboxes_destroy_selected({ n: names.length })}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.sandboxes_bulk_destroy_title({ n: names.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.sandboxes_bulk_destroy_desc()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.sandboxes_keep_it()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={destroyAll}>
            {m.sandboxes_destroy()}
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
        <h1 className="text-xl font-medium">{m.sandboxes_page_title()}</h1>
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
            placeholder={m.sandboxes_search_placeholder()}
          />
        </InputGroup>
        <FilterMenu
          label={m.sandboxes_filter_state()}
          value={stateFilter === 'all' ? '' : stateFilter}
          options={STATE_FILTERS.map((state) => ({
            value: state,
            label: stateLabel(state),
          }))}
          onChange={(value) => {
            setStateFilter(value === '' ? 'all' : (value as SandboxState));
            setPage(1);
          }}
        />
        {metadataOptions.length > 0 && (
          <FilterMenu
            label={m.sandboxes_filter_labels()}
            value={metadataFilter}
            options={metadataOptions}
            onChange={(value) => {
              setMetadataFilter(value);
              setPage(1);
            }}
          />
        )}
        <span className="text-sm text-muted-foreground">
          {m.sandboxes_count_of_total({
            filtered: filtered.length,
            total: sandboxes.length,
          })}
        </span>
        {selectedVisible.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            {/* 批量改策略与批量销毁同住选中操作区:圈定沙箱靠的就是
                这页的筛选+勾选,不另设策略页(策略不是实体)。改完不清
                选中 — 行还在,顺手核对或接着销毁都用得上这批勾。 */}
            <EditPolicyDialog sandboxes={selectedVisible} />
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
            <EmptyTitle>{m.sandboxes_empty_title()}</EmptyTitle>
            <EmptyDescription>{m.sandboxes_empty_desc()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {query.isSuccess && sandboxes.length > 0 && filtered.length === 0 && (
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{m.sandboxes_no_match_title()}</EmptyTitle>
            <EmptyDescription>{m.sandboxes_no_match_desc()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {filtered.length > 0 && (
        // fill:表格占满剩余高度框内滚,表头吸顶 — 列名滚不丢。
        // table-fixed 是「全表不横滚」的物理保证:列宽由表头一次定死,
        // 超长的名称/模板在自己列里省略号收场(全文在 title),而不是把
        // 整张表撑出横向滚动条。定宽列按内容给宽(数字列的下限是 Meter
        // 条的 w-16 + 边距);名称不定宽,吃掉全部剩余 — 它是表的主键,
        // 窗口变窄时也是它先变短,数字列不挤压。
        <DataTable fill className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">
                <Checkbox
                  aria-label={m.sandboxes_select_all_aria()}
                  checked={allVisibleSelected}
                  onCheckedChange={toggleAll}
                />
              </TableHead>
              <TableHead>
                <SortableHead
                  label={m.sandboxes_col_name()}
                  sortKey="name"
                  sort={sort}
                  onSort={toggleSort}
                />
              </TableHead>
              <TableHead className="w-24">{m.sandboxes_col_state()}</TableHead>
              <TableHead className="w-32">
                {m.sandboxes_col_template()}
              </TableHead>
              <TableHead className="w-32 text-right">CPU</TableHead>
              <TableHead className="w-32 text-right">
                {m.sandboxes_col_memory()}
              </TableHead>
              <TableHead className="w-32 text-right">
                {m.sandboxes_col_disk()}
              </TableHead>
              <TableHead className="w-26">
                <SortableHead
                  label={m.sandboxes_col_created()}
                  sortKey="createdAt"
                  sort={sort}
                  onSort={toggleSort}
                />
              </TableHead>
              <TableHead className="w-26">
                {/* 升序 = 最久没动的排最前:回收磁盘时先看这里 — 生命
                    周期策略从最后活动起算,这列才是"谁快被降温"的信号。
                    「策略」列刻意不设(2026-07-17 版式取舍):低频配置、
                    还是唯一会折行撑高行的列,归详情页。全表单行,不横滚。 */}
                <SortableHead
                  label={m.sandboxes_col_idle()}
                  sortKey="lastActiveAt"
                  sort={sort}
                  onSort={toggleSort}
                />
              </TableHead>
              <TableHead className="w-18 text-right">
                {m.sandboxes_col_actions()}
              </TableHead>
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
                    aria-label={m.sandboxes_select_one_aria({
                      name: sandbox.name,
                    })}
                    checked={selected.has(sandbox.name)}
                    onCheckedChange={() => toggleOne(sandbox.name)}
                  />
                </TableCell>
                <TableCell>
                  <Link
                    to="/sandboxes/$name"
                    params={{ name: sandbox.name }}
                    className="block truncate font-mono font-medium hover:underline"
                    title={sandbox.name}
                  >
                    {sandbox.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <SandboxStateBadge state={sandbox.state} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {/* Badge 自带 shrink-0:列不够宽时省略的是模板名,
                      「可升级」标记寸步不让 — 它是行动信号,名字有 title 兜底。 */}
                  <span className="flex items-center gap-1.5">
                    {/* 链接指向模板列表页(没有逐模板详情页);基础镜像
                        不是模板,没有可去处,保持纯文本。 */}
                    {sandbox.template ? (
                      <Link
                        to="/templates"
                        className="truncate hover:text-foreground hover:underline"
                        title={sandbox.template}
                      >
                        {sandbox.template}
                      </Link>
                    ) : (
                      m.sandboxes_base_image()
                    )}
                    <UpgradableBadge lineage={lineageOf.get(sandbox.name)} />
                  </span>
                </TableCell>
                {(() => {
                  const metrics = metricsOf.get(sandbox.name);
                  if (!metrics) {
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
                        value={`${Math.round(metrics.cpuUsedPct)}%`}
                        cap={`${metrics.cpuCount} vCPU`}
                        pct={metrics.cpuUsedPct / metrics.cpuCount}
                        title={m.sandboxes_cpu_col_title()}
                      />
                      <UsageCell
                        value={formatBytes(metrics.memUsedBytes)}
                        cap={formatCap(metrics.memTotalBytes)}
                        pct={pctOf(metrics.memUsedBytes, metrics.memTotalBytes)}
                      />
                      <UsageCell
                        value={formatBytes(metrics.diskUsedBytes)}
                        cap={formatCap(metrics.diskTotalBytes)}
                        pct={pctOf(
                          metrics.diskUsedBytes,
                          metrics.diskTotalBytes,
                        )}
                        title={m.sandboxes_disk_col_title()}
                      />
                    </>
                  );
                })()}
                {/* 两列都是粗粒度相对时刻(ago),精确时间戳在 title —
                    扫表要的是数量级,查证才要精确到秒。 */}
                <TableCell
                  className="tabular-nums text-muted-foreground"
                  title={m.sandboxes_created_at_title({
                    time: new Date(sandbox.createdAt).toLocaleString(),
                  })}
                >
                  {ago(sandbox.createdAt)}
                </TableCell>
                <TableCell
                  className="tabular-nums text-muted-foreground"
                  title={m.sandboxes_last_active_title({
                    time: new Date(sandbox.lastActiveAt).toLocaleString(),
                  })}
                >
                  {ago(sandbox.lastActiveAt)}
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
