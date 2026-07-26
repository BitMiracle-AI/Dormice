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
import { m } from '@/paraglide/messages';
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
              {value ? value.toLocaleDateString() : m.apikeys_never_expires()}
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
          {m.apikeys_clear()}
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
            {m.apikeys_create_button()}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        {minted === null ? (
          <>
            <DialogHeader>
              <DialogTitle>{m.apikeys_create_title()}</DialogTitle>
              <DialogDescription>
                {m.apikeys_create_description()}
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
                  <FieldLabel htmlFor="apikey-name">
                    {m.apikeys_name_label()}
                  </FieldLabel>
                  <Input
                    id="apikey-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="ci"
                    className="font-mono"
                  />
                  <FieldDescription>
                    {m.apikeys_name_description()}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="apikey-expiry">
                    {m.apikeys_expiry_label()}
                  </FieldLabel>
                  <ExpiryPicker
                    id="apikey-expiry"
                    value={expiry}
                    onChange={setExpiry}
                  />
                  <FieldDescription>
                    {m.apikeys_expiry_description()}
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
                  {m.apikeys_create_submit()}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {m.apikeys_created_title({ name: minted.name })}
              </DialogTitle>
              <DialogDescription>
                {m.apikeys_created_description()}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
                {minted.token}
              </code>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={m.apikeys_copy_key_aria()}
                onClick={() =>
                  copyText(minted.token).then(
                    () => toast.success(m.apikeys_key_copied()),
                    () => toast.error(m.apikeys_copy_failed_manual()),
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
                    () => toast.success(m.apikeys_connect_copied()),
                    () => toast.error(m.apikeys_copy_failed_manual()),
                  )
                }
              >
                {m.apikeys_copy_connect()}
              </Button>
              <Button onClick={() => onOpenChange(false)}>
                {m.apikeys_saved_it()}
              </Button>
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
          toast.success(
            m.apikeys_updated_toast({ name: patch.name ?? apiKey.name }),
          );
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
          <DialogTitle>
            {m.apikeys_edit_title({ name: apiKey.name })}
          </DialogTitle>
          <DialogDescription>{m.apikeys_edit_description()}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="apikey-edit-name">
                {m.apikeys_name_label()}
              </FieldLabel>
              <Input
                id="apikey-edit-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="font-mono"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="apikey-edit-expiry">
                {m.apikeys_expiry_label()}
              </FieldLabel>
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
              {m.common_save()}
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
          ? toast.success(m.apikeys_revoked_toast({ name: apiKey.name }))
          : toast.error(m.apikeys_revoke_gone_toast({ name: apiKey.name })),
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.apikeys_revoke_title({ name: apiKey.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.apikeys_revoke_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.apikeys_keep_it()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={revoke}>
            {m.apikeys_revoke()}
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
              aria-label={m.apikeys_row_actions_aria({ name: apiKey.name })}
            >
              <HugeiconsIcon icon={MoreVerticalIcon} />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <HugeiconsIcon icon={Edit02Icon} />
            {m.common_edit()}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setRevokeOpen(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} />
            {m.apikeys_revoke()}
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
      toast.error(m.apikeys_bulk_revoke_failed({ names: failures.join('、') }));
    } else {
      toast.success(m.apikeys_bulk_revoked({ count: keys.length }));
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
        {m.apikeys_bulk_revoke_button({ count: keys.length })}
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.apikeys_bulk_revoke_title({ count: keys.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.apikeys_bulk_revoke_description({
                names: keys.map((k) => k.name).join('、'),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>
              {m.apikeys_keep_it()}
            </AlertDialogCancel>
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
              {m.apikeys_revoke_all()}
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
  { className?: string; variant: 'outline' | 'secondary' }
> = {
  active: { variant: 'outline' },
  disabled: {
    variant: 'outline',
    className:
      'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  expired: {
    variant: 'outline',
    className:
      'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  revoked: { variant: 'secondary' },
};

/** 状态徽章文案按当前 locale 渲染时取值,不进模块级常量表。 */
function statusLabel(status: ReturnType<typeof apiKeyStatus>): string {
  switch (status) {
    case 'active':
      return m.apikeys_status_active();
    case 'disabled':
      return m.apikeys_status_disabled();
    case 'expired':
      return m.apikeys_status_expired();
    case 'revoked':
      return m.apikeys_status_revoked();
  }
}

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
          <h1 className="text-xl font-medium">{m.apikeys_page_title()}</h1>
          {selectedLive.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {m.apikeys_selected_count({ count: selectedLive.length })}
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
                aria-label={m.apikeys_select_all_aria()}
              />
            </TableHead>
            <TableHead>{m.apikeys_col_name()}</TableHead>
            <TableHead>{m.apikeys_col_prefix()}</TableHead>
            <TableHead>{m.apikeys_col_created()}</TableHead>
            <TableHead>{m.apikeys_col_last_used()}</TableHead>
            <TableHead>{m.apikeys_col_expiry()}</TableHead>
            <TableHead>{m.apikeys_col_enabled()}</TableHead>
            <TableHead>{m.apikeys_col_status()}</TableHead>
            <TableHead className="text-right">
              {m.apikeys_col_actions()}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* 引导凭证的虚拟行:不在账本、不进分页与选择集,只为让
              「全部凭证」在一张表里可见。 */}
          <TableRow className="bg-muted/30">
            <TableCell />
            <TableCell
              className="font-mono font-medium"
              title={m.apikeys_env_row_title()}
            >
              <span className="flex items-center gap-2">
                DORMICE_API_TOKEN
                <Badge variant="secondary">{m.apikeys_badge_default()}</Badge>
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {m.apikeys_env_var()}
            </TableCell>
            <TableCell className="text-muted-foreground">—</TableCell>
            <TableCell className="text-muted-foreground">—</TableCell>
            <TableCell className="text-muted-foreground">
              {m.apikeys_never_expires()}
            </TableCell>
            <TableCell />
            <TableCell>
              <Badge variant="outline">{m.apikeys_badge_resident()}</Badge>
            </TableCell>
            <TableCell />
          </TableRow>

          {query.isSuccess && keys.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={9}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                {m.apikeys_empty()}
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
                    aria-label={m.apikeys_select_one_aria({
                      name: apiKey.name,
                    })}
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
                  {apiKey.lastUsedAt
                    ? ago(apiKey.lastUsedAt)
                    : m.apikeys_never_used()}
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
                    ? m.apikeys_never_expires()
                    : status === 'expired' || status === 'revoked'
                      ? new Date(apiKey.expiresAt).toLocaleDateString()
                      : m.apikeys_expires_in({
                          duration: until(apiKey.expiresAt),
                        })}
                </TableCell>
                <TableCell>
                  {!revoked && (
                    <Switch
                      checked={apiKey.disabledAt === null}
                      disabled={update.isPending}
                      aria-label={m.apikeys_enable_switch_aria({
                        name: apiKey.name,
                      })}
                      onCheckedChange={(enabled) =>
                        update.mutate(
                          { id: apiKey.id, disabled: !enabled },
                          {
                            onSuccess: () =>
                              toast.success(
                                enabled
                                  ? m.apikeys_enabled_toast({
                                      name: apiKey.name,
                                    })
                                  : m.apikeys_disabled_toast({
                                      name: apiKey.name,
                                    }),
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
                    {statusLabel(status)}
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
