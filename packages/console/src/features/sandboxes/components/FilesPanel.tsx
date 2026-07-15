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
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { EnvdEntry } from '../envd-client';
import { STATE_LABELS } from '../format';
import {
  useDirectory,
  useDirectoryWatch,
  useEnvdAuth,
  useFileMutations,
} from '../hooks/useEnvd';
import { FilePreviewDialog } from './FilePreviewDialog';

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
  // 沙箱里(agent、终端)动了文件,这张表 2 秒内自己跟上 — 不用手点刷新。
  useDirectoryWatch(auth.data, path, {
    enabled: unlocked,
    active: sandbox.state === 'active',
  });
  const mutations = useFileMutations(auth.data);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 对话框状态:预览 / 新建文件夹 / 重命名 / 删除,一次只开一个。
  const [viewing, setViewing] = useState<EnvdEntry | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [renaming, setRenaming] = useState<EnvdEntry | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [deleting, setDeleting] = useState<EnvdEntry | null>(null);
  // 拖拽悬停的视觉反馈;计数器抵消子元素间的 dragenter/dragleave 抖动。
  const [dragDepth, setDragDepth] = useState(0);

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

  // 逐个串行上传:一次汇报总成败,失败点名到文件。
  const upload = async (files: File[]) => {
    const failures: string[] = [];
    for (const file of files) {
      try {
        await mutations.upload.mutateAsync({
          path: `${path}/${file.name}`,
          file,
        });
      } catch {
        failures.push(file.name);
      }
    }
    if (failures.length === 0) {
      const only = files.length === 1 ? files[0] : undefined;
      toast.success(
        only ? `已上传 ${only.name}` : `已上传 ${files.length} 个文件`,
      );
    } else {
      toast.error(`${failures.length} 个上传失败:${failures.join('、')}`);
    }
  };

  return (
    // 拖放只是「上传」按钮的增强,不是唯一入口;section 让辅助技术
    // 知道这一块是文件工作区,而不是把版面 div 假装成控件。
    <section
      aria-label="文件浏览器(支持拖放上传)"
      className={cn(
        'flex flex-col gap-3 rounded-lg transition-shadow',
        dragDepth > 0 && 'ring-2 ring-primary/60',
      )}
      // 拖文件进来直接落到当前目录 — 和上传按钮同一条路。
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragDepth((depth) => depth + 1);
      }}
      onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
      onDrop={(event) => {
        event.preventDefault();
        setDragDepth(0);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) void upload(files);
      }}
    >
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
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) void upload(files);
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
            <EmptyDescription>
              上传一个文件试试 — 拖进这个区域也行。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {entries.length > 0 && (
        <DataTable>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead className="text-right">大小</TableHead>
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
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 hover:underline"
                        onClick={() => setViewing(entry)}
                      >
                        <HugeiconsIcon
                          icon={File01Icon}
                          className="size-4 text-muted-foreground"
                        />
                        {entry.name}
                      </button>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
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
        </DataTable>
      )}

      {/* 预览/编辑 */}
      <FilePreviewDialog
        auth={auth.data}
        entry={viewing}
        onClose={() => setViewing(null)}
      />

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
    </section>
  );
}
