import { type ApiKey, apiKeyStatus } from '@dormice/shared';
import {
  Add01Icon,
  Calendar03Icon,
  Copy01Icon,
  Delete02Icon,
  Edit02Icon,
  MoreVerticalIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/DataTable';
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
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ago, until } from '@/features/sandboxes/format';
import { copyText } from '@/lib/copy';
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  useUpdateApiKey,
} from '../hooks/useApiKeys';

/** 选中的日期 → 当地时区当日 23:59:59.999 的 ISO:"到 8 月 1 日"自然读作"8 月 1 日当天还能用"。 */
function endOfDayIso(date: Date): string {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  ).toISOString();
}

/**
 * 过期日期选择:Popover + Calendar,不选 = 永不过期,选了可一键清除。
 * 只到日粒度 — 密钥过期是"这周/这季度"级别的决定,时分秒是伪精度。
 */
function ExpiryPicker({
  value,
  onChange,
  id,
}: {
  value: Date | undefined;
  onChange: (next: Date | undefined) => void;
  id: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              className="justify-start font-normal"
            >
              <HugeiconsIcon icon={Calendar03Icon} />
              {value ? value.toLocaleDateString() : '永不过期'}
            </Button>
          }
        />
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value}
            onSelect={(next) => {
              onChange(next ?? undefined);
              setOpen(false);
            }}
            disabled={{ before: new Date() }}
          />
        </PopoverContent>
      </Popover>
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(undefined)}
        >
          清除
        </Button>
      )}
    </div>
  );
}

/**
 * 铸造对话框演两幕:表单幕收名字和可选过期日,成功幕展示 token — daemon
 * 只存哈希,这是 token 在世上唯一一次露面,所以成功后不自动关窗,复制
 * 按钮、「复制接入配置」和「只显示这一次」的警告都长在这一幕里。关窗即
 * 翻篇,token 随之消失。
 */
function CreateApiKeyDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<Date | undefined>(undefined);
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(
    null,
  );
  const mutation = useCreateApiKey();

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setName('');
      setExpiry(undefined);
      setMinted(null);
      mutation.reset();
    }
  };

  // 接入配置 = 端点 + 凭证,一次粘进 CI secrets 或 shell 配置。端点用
  // 当前页面的 origin:操作员就是从这个地址够到 daemon 的。
  const connectSnippet = (token: string) =>
    `DORMICE_ENDPOINT=${window.location.origin}\nDORMICE_API_TOKEN=${token}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm">
            <HugeiconsIcon icon={Add01Icon} />
            创建密钥
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        {minted === null ? (
          <>
            <DialogHeader>
              <DialogTitle>创建 API 密钥</DialogTitle>
              <DialogDescription>
                密钥与 DORMICE_API_TOKEN 等效通行(SDK、CLI、E2B 包都认),
                区别是可以在这里随时停用或吊销,不用改服务器配置、不用重启。
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate(
                  {
                    name,
                    ...(expiry ? { expiresAt: endOfDayIso(expiry) } : {}),
                  },
                  {
                    onSuccess: ({ apiKey, token }) =>
                      setMinted({ name: apiKey.name, token }),
                  },
                );
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="apikey-name">名字</FieldLabel>
                  <Input
                    id="apikey-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="ci"
                    className="font-mono"
                  />
                  <FieldDescription>
                    给人看的把手,比如 ci、laptop。
                    同名同时只能有一把未吊销的密钥,吊销后名字可以再用。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="apikey-expiry">过期日期</FieldLabel>
                  <ExpiryPicker
                    id="apikey-expiry"
                    value={expiry}
                    onChange={setExpiry}
                  />
                  <FieldDescription>
                    到期当天过完即失效;之后可以在编辑里延期或清除。
                  </FieldDescription>
                </Field>
                {mutation.isError && (
                  <FieldError>{mutation.error.message}</FieldError>
                )}
              </FieldGroup>
              <DialogFooter className="mt-6">
                <Button
                  type="submit"
                  disabled={name.trim() === '' || mutation.isPending}
                >
                  {mutation.isPending && <Spinner />}
                  创建
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>「{minted.name}」已创建</DialogTitle>
              <DialogDescription>
                这是密钥唯一一次显示 — daemon 只存哈希,关掉这个窗口就再也
                取不回来了。现在复制并存好。
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
                {minted.token}
              </code>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="复制密钥"
                onClick={() =>
                  copyText(minted.token).then(
                    () => toast.success('密钥已复制'),
                    () => toast.error('复制失败 — 请手动选中复制'),
                  )
                }
              >
                <HugeiconsIcon icon={Copy01Icon} />
              </Button>
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
              <Button
                variant="outline"
                onClick={() =>
                  copyText(connectSnippet(minted.token)).then(
                    () => toast.success('接入配置已复制 — 端点与凭证两行'),
                    () => toast.error('复制失败 — 请手动选中复制'),
                  )
                }
              >
                复制接入配置
              </Button>
              <Button onClick={() => onOpenChange(false)}>我已存好</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 编辑弹窗:改名 + 改过期,只提交真正变化的字段(updateApiKey 的 patch
 * 语义)。过期字段带 touched 标记 — 服务端存的 ISO 精确到毫秒,不碰它
 * 就不该上 wire,否则会把别处设的精确时刻悄悄挪到当日末。
 */
function EditApiKeyDialog({
  apiKey,
  open,
  onOpenChange,
}: {
  apiKey: ApiKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(apiKey.name);
  const [expiry, setExpiry] = useState<Date | undefined>(
    apiKey.expiresAt ? new Date(apiKey.expiresAt) : undefined,
  );
  const [expiryTouched, setExpiryTouched] = useState(false);
  const mutation = useUpdateApiKey();

  const reset = (next: boolean) => {
    if (next) {
      setName(apiKey.name);
      setExpiry(apiKey.expiresAt ? new Date(apiKey.expiresAt) : undefined);
      setExpiryTouched(false);
      mutation.reset();
    }
    onOpenChange(next);
  };

  const submit = () => {
    const patch: { name?: string; expiresAt?: string | null } = {};
    if (name.trim() !== apiKey.name) patch.name = name.trim();
    if (expiryTouched) patch.expiresAt = expiry ? endOfDayIso(expiry) : null;
    if (Object.keys(patch).length === 0) {
      onOpenChange(false);
      return;
    }
    mutation.mutate(
      { id: apiKey.id, ...patch },
      {
        onSuccess: () => {
          toast.success(`已更新「${patch.name ?? apiKey.name}」`);
          onOpenChange(false);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑「{apiKey.name}」</DialogTitle>
          <DialogDescription>
            改名或调整过期日期。密钥本体不可见也不可换 — 要换材质就吊销重铸。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="apikey-edit-name">名字</FieldLabel>
              <Input
                id="apikey-edit-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="font-mono"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="apikey-edit-expiry">过期日期</FieldLabel>
              <ExpiryPicker
                id="apikey-edit-expiry"
                value={expiry}
                onChange={(next) => {
                  setExpiry(next);
                  setExpiryTouched(true);
                }}
              />
            </Field>
            {mutation.isError && (
              <FieldError>{mutation.error.message}</FieldError>
            )}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button
              type="submit"
              disabled={name.trim() === '' || mutation.isPending}
            >
              {mutation.isPending && <Spinner />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevokeApiKeyDialog({
  apiKey,
  open,
  onOpenChange,
}: {
  apiKey: ApiKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useRevokeApiKey();

  const revoke = () =>
    mutation.mutate(apiKey.id, {
      // false 要说响亮:漏杀一把泄露的密钥比报错更糟。
      onSuccess: ({ revoked }) =>
        revoked
          ? toast.success(`已吊销「${apiKey.name}」— 下一个请求就失效`)
          : toast.error(`「${apiKey.name}」已不在 — 没有吊销任何东西`),
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>吊销密钥「{apiKey.name}」?</AlertDialogTitle>
          <AlertDialogDescription>
            立即生效,不可恢复 — 还在用它的客户端下一个请求就会 401。
            只是暂时不用的话,停用开关是可逆的。记录会留在列表里作
            轮换历史,名字可以再用。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>先留着</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={revoke}>
            吊销
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** 行操作收进「⋯」菜单;弹窗挂菜单外 — 菜单关闭即卸载,放里面会跟着消失。 */
function ApiKeyRowMenu({ apiKey }: { apiKey: ApiKey }) {
  const [editOpen, setEditOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${apiKey.name} 的操作`}
            >
              <HugeiconsIcon icon={MoreVerticalIcon} />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <HugeiconsIcon icon={Edit02Icon} />
            编辑
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setRevokeOpen(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} />
            吊销
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EditApiKeyDialog
        apiKey={apiKey}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <RevokeApiKeyDialog
        apiKey={apiKey}
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
      />
    </>
  );
}

/** 批量吊销:逐个顺序执行,失败点名,成功一句汇总(BulkDestroyButton 同款)。 */
function BulkRevokeButton({
  keys,
  onDone,
}: {
  keys: ApiKey[];
  onDone: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const mutation = useRevokeApiKey();
  const [running, setRunning] = useState(false);

  const revokeAll = async () => {
    setRunning(true);
    const failures: string[] = [];
    for (const key of keys) {
      try {
        await mutation.mutateAsync(key.id);
      } catch {
        failures.push(key.name);
      }
    }
    setRunning(false);
    setConfirmOpen(false);
    onDone();
    if (failures.length > 0) {
      toast.error(`吊销失败:${failures.join('、')}`);
    } else {
      toast.success(`已吊销 ${keys.length} 把密钥`);
    }
  };

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => setConfirmOpen(true)}
      >
        <HugeiconsIcon icon={Delete02Icon} />
        吊销所选({keys.length})
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              吊销选中的 {keys.length} 把密钥?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {keys.map((k) => k.name).join('、')}—
              立即生效,不可恢复,还在用它们的客户端下一个请求就会 401。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>先留着</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={running}
              onClick={(event) => {
                // 手动跑完再关窗:批量是多个请求,关窗即失控。
                event.preventDefault();
                void revokeAll();
              }}
            >
              {running && <Spinner />}
              吊销全部
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const PAGE_SIZE = 50;
const SOON_MS = 7 * 24 * 3600_000;

const STATUS_BADGE: Record<
  ReturnType<typeof apiKeyStatus>,
  { label: string; className?: string; variant: 'outline' | 'secondary' }
> = {
  active: { label: '活跃', variant: 'outline' },
  disabled: {
    label: '已停用',
    variant: 'outline',
    className:
      'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  expired: {
    label: '已过期',
    variant: 'outline',
    className:
      'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  revoked: { label: '已吊销', variant: 'secondary' },
};

/**
 * API 密钥账本:铸造、编辑、启停、吊销,批量与分页齐备。密钥本体永不
 * 再现(daemon 只存哈希),所以表格只有前缀可看;已吊销的行留着 — 那是
 * 轮换历史,不是垃圾。DORMICE_API_TOKEN 以置顶虚拟行的身份出现:它不在
 * 账本里,轮换它 = 改服务器配置并重启,这里只让它可见,不让它可操作 —
 * 管理动词(含本页全部按钮)也只认它或 console 登录态,密钥管不了密钥。
 */
export function ApiKeysPage() {
  const query = useApiKeys();
  const keys = query.data?.apiKeys ?? [];
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const update = useUpdateApiKey();
  const { rows, safePage, pageCount } = paginate(keys, page, PAGE_SIZE);
  const now = Date.now();

  // 选择向现实收敛:被别处吊销的行自动掉出选择集;可选 = 当前页未吊销行。
  const selectable = rows.filter((k) => k.revokedAt === null);
  const selectedLive = keys.filter(
    (k) => selected.has(k.id) && k.revokedAt === null,
  );
  const allSelected =
    selectable.length > 0 && selectable.every((k) => selected.has(k.id));

  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of selectable) {
        if (allSelected) next.delete(k.id);
        else next.add(k.id);
      }
      return next;
    });

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    // openasi 列表页版式(2026-07-16 用户拍板):限宽居中、表格吃掉剩余
    // 高度框内滚、分页条钉底。
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-medium">API 密钥</h1>
          {selectedLive.length > 0 && (
            <span className="text-sm text-muted-foreground">
              已选 {selectedLive.length} 把
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {selectedLive.length > 0 && (
            <BulkRevokeButton
              keys={selectedLive}
              onDone={() => setSelected(new Set())}
            />
          )}
          <CreateApiKeyDialog />
        </div>
      </header>

      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      )}

      <DataTable fill>
        <TableHeader>
          <TableRow>
            <TableHead className="w-0">
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAll}
                disabled={selectable.length === 0}
                aria-label="全选本页"
              />
            </TableHead>
            <TableHead>名字</TableHead>
            <TableHead>前缀</TableHead>
            <TableHead>创建</TableHead>
            <TableHead>最后使用</TableHead>
            <TableHead>过期</TableHead>
            <TableHead>启用</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* 引导凭证的虚拟行:不在账本、不进分页与选择集,只为让
              「全部凭证」在一张表里可见。 */}
          <TableRow className="bg-muted/30">
            <TableCell />
            <TableCell
              className="font-mono font-medium"
              title="引导/恢复凭证,来自服务器环境变量 — 轮换它 = 改服务器配置并重启 daemon,console 无法吊销"
            >
              <span className="flex items-center gap-2">
                DORMICE_API_TOKEN
                <Badge variant="secondary">默认</Badge>
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground">环境变量</TableCell>
            <TableCell className="text-muted-foreground">—</TableCell>
            <TableCell className="text-muted-foreground">—</TableCell>
            <TableCell className="text-muted-foreground">永不过期</TableCell>
            <TableCell />
            <TableCell>
              <Badge variant="outline">常驻</Badge>
            </TableCell>
            <TableCell />
          </TableRow>

          {query.isSuccess && keys.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={9}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                还没有账本密钥 — 现在全靠上面那一枚环境变量凭证。
                给每个客户端创建一把密钥,泄露时吊销那一把就够,不用全局换钥匙。
              </TableCell>
            </TableRow>
          )}

          {rows.map((apiKey) => {
            const status = apiKeyStatus(apiKey, now);
            const revoked = status === 'revoked';
            const badge = STATUS_BADGE[status];
            const expiresSoon =
              apiKey.expiresAt !== null &&
              status === 'active' &&
              Date.parse(apiKey.expiresAt) - now < SOON_MS;
            return (
              <TableRow
                key={apiKey.id}
                data-state={selected.has(apiKey.id) ? 'selected' : undefined}
                className={revoked ? 'text-muted-foreground' : undefined}
              >
                <TableCell>
                  <Checkbox
                    checked={selected.has(apiKey.id)}
                    onCheckedChange={() => toggleOne(apiKey.id)}
                    disabled={revoked}
                    aria-label={`选择 ${apiKey.name}`}
                  />
                </TableCell>
                <TableCell className="font-mono font-medium">
                  {apiKey.name}
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {apiKey.prefix}
                  ••••
                </TableCell>
                <TableCell
                  className="tabular-nums text-muted-foreground"
                  title={new Date(apiKey.createdAt).toLocaleString()}
                >
                  {ago(apiKey.createdAt)}
                </TableCell>
                <TableCell
                  className="tabular-nums text-muted-foreground"
                  title={
                    apiKey.lastUsedAt
                      ? new Date(apiKey.lastUsedAt).toLocaleString()
                      : undefined
                  }
                >
                  {apiKey.lastUsedAt ? ago(apiKey.lastUsedAt) : '从未'}
                </TableCell>
                <TableCell
                  className={`tabular-nums ${
                    expiresSoon
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground'
                  }`}
                  title={
                    apiKey.expiresAt
                      ? new Date(apiKey.expiresAt).toLocaleString()
                      : undefined
                  }
                >
                  {apiKey.expiresAt === null
                    ? '永不过期'
                    : status === 'expired' || status === 'revoked'
                      ? new Date(apiKey.expiresAt).toLocaleDateString()
                      : `${until(apiKey.expiresAt)}后`}
                </TableCell>
                <TableCell>
                  {!revoked && (
                    <Switch
                      checked={apiKey.disabledAt === null}
                      disabled={update.isPending}
                      aria-label={`${apiKey.name} 启用开关`}
                      onCheckedChange={(enabled) =>
                        update.mutate(
                          { id: apiKey.id, disabled: !enabled },
                          {
                            onSuccess: () =>
                              toast.success(
                                enabled
                                  ? `已启用「${apiKey.name}」`
                                  : `已停用「${apiKey.name}」— 可随时重新启用`,
                              ),
                            onError: (error) => toast.error(error.message),
                          },
                        )
                      }
                    />
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={badge.variant} className={badge.className}>
                    {badge.label}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {!revoked && <ApiKeyRowMenu apiKey={apiKey} />}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </DataTable>

      <TablePager
        page={safePage}
        pageCount={pageCount}
        total={keys.length}
        onPageChange={setPage}
      />
    </div>
  );
}
