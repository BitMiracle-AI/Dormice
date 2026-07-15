import type { ApiKey } from '@dormice/shared';
import {
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
  Key01Icon,
  MoreVerticalIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/DataTable';
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { since } from '@/features/sandboxes/format';
import { copyText } from '@/lib/copy';
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
} from '../hooks/useApiKeys';

/**
 * 铸造对话框演两幕:表单幕收名字,成功幕展示 token — daemon 只存哈希,
 * 这是 token 在世上唯一一次露面,所以成功后不自动关窗,复制按钮和
 * 「只显示这一次」的警告都长在这一幕里。关窗即翻篇,token 随之消失。
 */
function CreateApiKeyDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(
    null,
  );
  const mutation = useCreateApiKey();

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setName('');
      setMinted(null);
      mutation.reset();
    }
  };

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
                区别是可以在这里随时吊销,不用改服务器配置、不用重启。
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate(name, {
                  onSuccess: ({ apiKey, token }) =>
                    setMinted({ name: apiKey.name, token }),
                });
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
                    同名同时只能有一把活跃密钥,吊销后名字可以再用。
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
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>我已存好</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeApiKeyDialog({
  name,
  open,
  onOpenChange,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useRevokeApiKey();

  const revoke = () =>
    mutation.mutate(name, {
      // false 要说响亮:漏杀一把泄露的密钥比报错更糟。
      onSuccess: ({ revoked }) =>
        revoked
          ? toast.success(`已吊销「${name}」— 下一个请求就失效`)
          : toast.error(`「${name}」名下没有活跃密钥 — 没有吊销任何东西`),
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>吊销密钥「{name}」?</AlertDialogTitle>
          <AlertDialogDescription>
            立即生效,不可恢复 — 还在用它的客户端下一个请求就会 401。
            记录会留在列表里作轮换历史,名字可以再用。
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

/** 行操作收进「⋯」菜单;吊销弹窗挂菜单外 — 菜单关闭即卸载,放里面会跟着消失。 */
function ApiKeyRowMenu({ apiKey }: { apiKey: ApiKey }) {
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
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setRevokeOpen(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} />
            吊销
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RevokeApiKeyDialog
        name={apiKey.name}
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
      />
    </>
  );
}

/**
 * API 密钥账本:铸造、吊销、看谁还活着。密钥本体永不再现(daemon 只存
 * 哈希),所以表格只有前缀可看;已吊销的行留着 — 那是轮换历史,不是垃圾。
 * DORMICE_API_TOKEN 不在这张表里:它是引导/恢复凭证,吊销它 = 改服务器
 * 配置文件。
 */
export function ApiKeysPage() {
  const query = useApiKeys();
  const keys = query.data?.apiKeys ?? [];

  return (
    // 六列窄表,同模板页限宽居中 — 宽屏上不摊大饼。
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">API 密钥</h1>
          <p className="text-sm text-muted-foreground">
            与 DORMICE_API_TOKEN 等效的可吊销凭证 — 轮换不停机,泄露即止损。
          </p>
        </div>
        <CreateApiKeyDialog />
      </div>

      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      )}

      {query.isSuccess && keys.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Key01Icon} />
            </EmptyMedia>
            <EmptyTitle>还没有 API 密钥</EmptyTitle>
            <EmptyDescription>
              现在全靠 DORMICE_API_TOKEN 一枚凭证。创建一把密钥给每个
              客户端,泄露时吊销那一把就够,不用全局换钥匙。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {keys.length > 0 && (
        <DataTable>
          <TableHeader>
            <TableRow>
              <TableHead>名字</TableHead>
              <TableHead>前缀</TableHead>
              <TableHead>创建</TableHead>
              <TableHead>最后使用</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((apiKey) => {
              const revoked = apiKey.revokedAt !== null;
              return (
                <TableRow
                  key={apiKey.id}
                  className={revoked ? 'text-muted-foreground' : undefined}
                >
                  <TableCell className="font-mono font-medium">
                    {apiKey.name}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {apiKey.prefix}…
                  </TableCell>
                  <TableCell
                    className="tabular-nums text-muted-foreground"
                    title={new Date(apiKey.createdAt).toLocaleString()}
                  >
                    {since(apiKey.createdAt)}前
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
                      ? `${since(apiKey.lastUsedAt)}前`
                      : '从未'}
                  </TableCell>
                  <TableCell>
                    {revoked ? (
                      <Badge variant="secondary">已吊销</Badge>
                    ) : (
                      <Badge variant="outline">活跃</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!revoked && <ApiKeyRowMenu apiKey={apiKey} />}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </DataTable>
      )}
    </div>
  );
}
