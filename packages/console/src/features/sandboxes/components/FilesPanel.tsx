import type { Sandbox } from '@dormice/shared';
import {
  Delete02Icon,
  Download01Icon,
  Edit02Icon,
  File01Icon,
  Folder01Icon,
  FolderAddIcon,
  MoreVerticalIcon,
  RefreshIcon,
  Upload01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Fragment, useRef, useState } from 'react';
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
} from '@/components/ui/alert-dialog';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes } from '@/lib/format';
import type { EnvdEntry } from '../envd-client';
import { STATE_LABELS } from '../format';
import { useDirectory, useEnvdAuth, useFileMutations } from '../hooks/useEnvd';

const HOME = '/home/user';

/** /home/user 下的面包屑段;根显示为 ~。 */
function segmentsOf(path: string): Array<{ label: string; path: string }> {
  const crumbs = [{ label: '~', path: HOME }];
  if (path === HOME) return crumbs;
  let acc = HOME;
  for (const segment of path.slice(HOME.length + 1).split('/')) {
    acc = `${acc}/${segment}`;
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}

function sortEntries(entries: EnvdEntry[]): EnvdEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'FILE_TYPE_DIRECTORY' ? 0 : 1;
    const bDir = b.type === 'FILE_TYPE_DIRECTORY' ? 0 : 1;
    return aDir - bDir || a.name.localeCompare(b.name);
  });
}

/**
 * 沙箱内 /home/user 的文件浏览器,走 envd 的 Filesystem RPC 与文件面 —
 * 与官方 e2b SDK 同一条 wire。文件动词会唤醒冻结的沙箱,所以非 active
 * 状态下第一步是一次显式的"打开"(与终端同一条纪律:看不解冻,用才解冻)。
 */
export function FilesPanel({ sandbox }: { sandbox: Sandbox }) {
  const [unlocked, setUnlocked] = useState(sandbox.state === 'active');
  const [path, setPath] = useState(HOME);
  const auth = useEnvdAuth(sandbox.sandboxId);
  const directory = useDirectory(auth.data, path, unlocked);
  const mutations = useFileMutations(auth.data);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 对话框状态:新建文件夹 / 重命名 / 删除,一次只开一个。
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [renaming, setRenaming] = useState<EnvdEntry | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [deleting, setDeleting] = useState<EnvdEntry | null>(null);

  if (!unlocked) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={Folder01Icon} />
          </EmptyMedia>
          <EmptyTitle>文件浏览器</EmptyTitle>
          <EmptyDescription>
            沙箱当前是「{STATE_LABELS[sandbox.state]}」— 浏览文件会唤醒它
            (冻结约 50ms,停止需要几秒冷启动)。看这一页本身不会。
          </EmptyDescription>
        </EmptyHeader>
        <Button size="sm" onClick={() => setUnlocked(true)}>
          打开文件浏览器
        </Button>
      </Empty>
    );
  }

  const entries = sortEntries(directory.data ?? []);

  const upload = (file: File) => {
    mutations.upload.mutate(
      { path: `${path}/${file.name}`, file },
      {
        onSuccess: () => toast.success(`已上传 ${file.name}`),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Breadcrumb>
          <BreadcrumbList>
            {segmentsOf(path).map((crumb, index, all) => (
              <Fragment key={crumb.path}>
                {index > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {index === all.length - 1 ? (
                    <BreadcrumbPage className="font-mono">
                      {crumb.label}
                    </BreadcrumbPage>
                  ) : (
                    <button
                      type="button"
                      className="font-mono transition-colors hover:text-foreground"
                      onClick={() => setPath(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload(file);
              event.target.value = '';
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={mutations.upload.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {mutations.upload.isPending ? (
              <Spinner />
            ) : (
              <HugeiconsIcon icon={Upload01Icon} />
            )}
            上传
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setMkdirName('');
              setMkdirOpen(true);
            }}
          >
            <HugeiconsIcon icon={FolderAddIcon} />
            新建文件夹
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="刷新"
            onClick={() => void directory.refetch()}
          >
            <HugeiconsIcon icon={RefreshIcon} />
          </Button>
        </div>
      </div>

      {(directory.isError || auth.isError) && (
        <Alert variant="destructive">
          <AlertDescription>
            {directory.error?.message ?? auth.error?.message}
          </AlertDescription>
        </Alert>
      )}

      {directory.isLoading && (
        <div className="flex items-center gap-2 rounded-lg border p-4 text-sm text-muted-foreground">
          <Spinner /> 读取目录(沉睡的沙箱会先被唤醒)
        </div>
      )}

      {directory.isSuccess && entries.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>空目录</EmptyTitle>
            <EmptyDescription>上传一个文件试试。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>大小</TableHead>
                <TableHead>权限</TableHead>
                <TableHead>修改时间</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const isDir = entry.type === 'FILE_TYPE_DIRECTORY';
                return (
                  <TableRow key={entry.path}>
                    <TableCell>
                      {isDir ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 font-medium hover:underline"
                          onClick={() => setPath(entry.path)}
                        >
                          <HugeiconsIcon
                            icon={Folder01Icon}
                            className="size-4 text-sky-500"
                          />
                          {entry.name}
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <HugeiconsIcon
                            icon={File01Icon}
                            className="size-4 text-muted-foreground"
                          />
                          {entry.name}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {isDir ? '—' : formatBytes(Number(entry.size))}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {entry.permissions}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(entry.modifiedTime).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`${entry.name} 的操作`}
                            >
                              <HugeiconsIcon icon={MoreVerticalIcon} />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end">
                          {!isDir && (
                            <DropdownMenuItem
                              onClick={() =>
                                mutations.download.mutate(
                                  { path: entry.path, name: entry.name },
                                  {
                                    onError: (error) =>
                                      toast.error(error.message),
                                  },
                                )
                              }
                            >
                              <HugeiconsIcon icon={Download01Icon} />
                              下载
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => {
                              setRenaming(entry);
                              setRenameTo(entry.name);
                            }}
                          >
                            <HugeiconsIcon icon={Edit02Icon} />
                            重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDeleting(entry)}
                          >
                            <HugeiconsIcon icon={Delete02Icon} />
                            删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 新建文件夹 */}
      <Dialog open={mkdirOpen} onOpenChange={setMkdirOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              mutations.mkdir.mutate(`${path}/${mkdirName}`, {
                onSuccess: () => setMkdirOpen(false),
                onError: (error) => toast.error(error.message),
              });
            }}
          >
            <Input
              autoFocus
              value={mkdirName}
              onChange={(event) => setMkdirName(event.target.value)}
              placeholder="文件夹名"
              className="font-mono"
            />
            <DialogFooter className="mt-4">
              <Button
                type="submit"
                disabled={mkdirName === '' || mutations.mkdir.isPending}
              >
                {mutations.mkdir.isPending && <Spinner />}
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 重命名 */}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名「{renaming?.name}」</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!renaming) return;
              mutations.move.mutate(
                {
                  source: renaming.path,
                  destination: `${path}/${renameTo}`,
                },
                {
                  onSuccess: () => setRenaming(null),
                  onError: (error) => toast.error(error.message),
                },
              );
            }}
          >
            <Input
              autoFocus
              value={renameTo}
              onChange={(event) => setRenameTo(event.target.value)}
              className="font-mono"
            />
            <DialogFooter className="mt-4">
              <Button
                type="submit"
                disabled={
                  renameTo === '' ||
                  renameTo === renaming?.name ||
                  mutations.move.isPending
                }
              >
                {mutations.move.isPending && <Spinner />}
                重命名
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 删除 */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleting?.name}」?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.type === 'FILE_TYPE_DIRECTORY'
                ? '整个目录连同里面的一切一起删除,'
                : ''}
              删了就没有了 — 沙箱里没有回收站。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先留着</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleting) return;
                mutations.remove.mutate(deleting.path, {
                  onSuccess: () => setDeleting(null),
                  onError: (error) => toast.error(error.message),
                });
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
