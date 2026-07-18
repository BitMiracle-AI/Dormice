import type { Sandbox } from '@dormice/shared';
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
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
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { Spinner } from '@/components/ui/spinner';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { EnvdAuth, EnvdEntry } from '../../envd-client';
import { STATE_LABELS } from '../../format';
import {
  useDirectory,
  useDirectoryWatch,
  useEnvdAuth,
  useFileMutations,
} from '../../hooks/useEnvd';
import { DeleteDialog, MkdirDialog, RenameDialog } from './file-dialogs';

const HOME = '/home/user';

/** /home/user → ~,其下路径缩写成 ~/x/y。 */
function tildify(path: string): string {
  return path === HOME ? '~' : `~${path.slice(HOME.length)}`;
}

function sortEntries(entries: EnvdEntry[]): EnvdEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'FILE_TYPE_DIRECTORY' ? 0 : 1;
    const bDir = b.type === 'FILE_TYPE_DIRECTORY' ? 0 : 1;
    return aDir - bDir || a.name.localeCompare(b.name);
  });
}

/** 递归组件间共享的树上下文 — 免得每层透传七个 props。 */
type TreeContext = {
  auth: EnvdAuth | undefined;
  unlocked: boolean;
  expanded: Set<string>;
  selectedPath: string | null;
  onDirClick: (entry: EnvdEntry) => void;
  onFileClick: (entry: EnvdEntry) => void;
  onDownload: (entry: EnvdEntry) => void;
  onRename: (entry: EnvdEntry) => void;
  onDelete: (entry: EnvdEntry) => void;
};

/**
 * 树的一层 = 一个 useDirectory(query key 按路径,一层一 query)。折叠的
 * 目录不渲染子层,也就不发请求 — 懒加载不用任何额外机制;展开过的层
 * 折叠后缓存仍在,mutation 的前缀失效(['envdDir', id])会让全树跟上。
 */
function TreeLevel({
  tree,
  path,
  depth,
}: {
  tree: TreeContext;
  path: string;
  depth: number;
}) {
  const directory = useDirectory(tree.auth, path, tree.unlocked);

  if (directory.isLoading) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <Spinner />
        {depth === 0 ? '读取目录(沉睡的沙箱会先被唤醒)' : '读取中'}
      </div>
    );
  }
  if (directory.isError) {
    return (
      <div
        className="px-2 py-1 text-xs text-destructive"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={directory.error.message}
      >
        读取失败:{directory.error.message}
      </div>
    );
  }

  const entries = sortEntries(directory.data ?? []);
  if (depth === 0 && entries.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        空目录 — 上传一个文件试试,拖进这个区域也行。
      </div>
    );
  }

  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.type === 'FILE_TYPE_DIRECTORY';
        const open = isDir && tree.expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <div className="group flex items-center pr-1">
              <button
                type="button"
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm hover:bg-muted',
                  !isDir && tree.selectedPath === entry.path && 'bg-muted',
                )}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
                onClick={() =>
                  isDir ? tree.onDirClick(entry) : tree.onFileClick(entry)
                }
              >
                <span className="w-3.5 shrink-0 text-muted-foreground">
                  {isDir && (
                    <HugeiconsIcon
                      icon={open ? ArrowDown01Icon : ArrowRight01Icon}
                      className="size-3.5"
                    />
                  )}
                </span>
                <HugeiconsIcon
                  icon={isDir ? Folder01Icon : File01Icon}
                  className={cn(
                    'size-4 shrink-0',
                    isDir ? 'text-sky-500' : 'text-muted-foreground',
                  )}
                />
                <span className="truncate" title={entry.name}>
                  {entry.name}
                </span>
                {!isDir && (
                  <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-muted-foreground">
                    {formatBytes(Number(entry.size))}
                  </span>
                )}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${entry.name} 的操作`}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                    >
                      <HugeiconsIcon icon={MoreVerticalIcon} />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  {!isDir && (
                    <DropdownMenuItem onClick={() => tree.onDownload(entry)}>
                      <HugeiconsIcon icon={Download01Icon} />
                      下载
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => tree.onRename(entry)}>
                    <HugeiconsIcon icon={Edit02Icon} />
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => tree.onDelete(entry)}
                  >
                    <HugeiconsIcon icon={Delete02Icon} />
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {open && (
              <TreeLevel tree={tree} path={entry.path} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * 工作台左栏:/home/user 的懒加载文件树,走 envd 的 Filesystem RPC —
 * 与官方 e2b SDK 同一条 wire。文件动词会唤醒冻结的沙箱,所以非 active
 * 状态下第一步是一次显式的"打开"(与终端同一条纪律:看不解冻,用才解冻)。
 *
 * 「焦点目录」是唯一的落点裁决:点文件 = 选中它 + 焦点到其父目录;点
 * 目录 = 展开/折叠 + 焦点到它。上传按钮、拖拽、新建文件夹、watch 布防
 * 全部落在焦点目录 — 规则只有一条,空目录也能当上传目标(点它即聚焦)。
 */
export function FileTreePane({
  sandbox,
  selected,
  onSelect,
}: {
  sandbox: Sandbox;
  selected: EnvdEntry | null;
  onSelect: (entry: EnvdEntry | null) => void;
}) {
  const [unlocked, setUnlocked] = useState(sandbox.state === 'active');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusDir, setFocusDir] = useState(HOME);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [renaming, setRenaming] = useState<EnvdEntry | null>(null);
  const [deleting, setDeleting] = useState<EnvdEntry | null>(null);
  // 拖拽悬停的视觉反馈;计数器抵消子元素间的 dragenter/dragleave 抖动。
  const [dragDepth, setDragDepth] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const auth = useEnvdAuth(sandbox.id);
  const mutations = useFileMutations(auth.data);
  const queryClient = useQueryClient();
  // watch 跟随焦点:只在焦点目录布一个 watcher(hook 以 path 为依赖,
  // 焦点切换自拆自装),不逐展开目录布防 — 布防要容器里起 inotifywait,
  // N 个展开目录 N 个进程不值得。
  useDirectoryWatch(auth.data, focusDir, {
    enabled: unlocked,
    active: sandbox.state === 'active',
  });

  // 删除/重命名后的状态收敛:命中选中文件(或其祖先目录)就清掉/跟上,
  // 展开集与焦点目录同步剪枝 — 不留指向已不存在路径的悬挂状态。
  const pruneUnder = (path: string) => {
    setExpanded(
      (prev) =>
        new Set(
          [...prev].filter((p) => p !== path && !p.startsWith(`${path}/`)),
        ),
    );
    setFocusDir((dir) =>
      dir === path || dir.startsWith(`${path}/`) ? HOME : dir,
    );
  };
  const handleDeleted = (path: string) => {
    if (
      selected &&
      (selected.path === path || selected.path.startsWith(`${path}/`))
    ) {
      onSelect(null);
    }
    pruneUnder(path);
  };
  const handleRenamed = (source: string, destination: string) => {
    if (selected?.path === source) {
      onSelect({
        ...selected,
        name: destination.slice(destination.lastIndexOf('/') + 1),
        path: destination,
      });
    } else if (selected?.path.startsWith(`${source}/`)) {
      // 选中文件藏在被改名的目录里,旧路径作废 — 诚实清空,胜过猜新路径。
      onSelect(null);
    }
    pruneUnder(source);
  };

  // 逐个串行上传到焦点目录:一次汇报总成败,失败点名到文件。
  const upload = async (files: File[]) => {
    const failures: string[] = [];
    for (const file of files) {
      try {
        await mutations.upload.mutateAsync({
          path: `${focusDir}/${file.name}`,
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

  if (!unlocked) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Empty>
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
      </div>
    );
  }

  return (
    // 拖放只是「上传」按钮的增强,不是唯一入口;section 让辅助技术
    // 知道这一块是文件工作区,而不是把版面 div 假装成控件。
    <section
      aria-label="文件树(支持拖放上传到焦点目录)"
      className={cn(
        'flex h-full min-h-0 flex-col transition-shadow',
        dragDepth > 0 && 'ring-2 ring-inset ring-primary/60',
      )}
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
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
          title={`焦点目录 ${focusDir} — 上传/新建落在这里`}
        >
          {tildify(focusDir)}
        </span>
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
          variant="ghost"
          size="icon-sm"
          aria-label="上传到焦点目录"
          disabled={mutations.upload.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          {mutations.upload.isPending ? (
            <Spinner />
          ) : (
            <HugeiconsIcon icon={Upload01Icon} />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="在焦点目录新建文件夹"
          onClick={() => setMkdirOpen(true)}
        >
          <HugeiconsIcon icon={FolderAddIcon} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新"
          onClick={() =>
            // 前缀失效 = 全树重扫;比逐层 refetch 省心,也和 mutation
            // 成功后的失效走同一条路。
            void queryClient.invalidateQueries({
              queryKey: ['envdDir', sandbox.id],
            })
          }
        >
          <HugeiconsIcon icon={RefreshIcon} />
        </Button>
      </div>

      {auth.isError && (
        <Alert variant="destructive" className="m-2">
          <AlertDescription>{auth.error.message}</AlertDescription>
        </Alert>
      )}

      <div className="min-h-0 flex-1 overflow-auto py-1.5 pl-1.5">
        <TreeLevel
          tree={{
            auth: auth.data,
            unlocked,
            expanded,
            selectedPath: selected?.path ?? null,
            onDirClick: (entry) => {
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(entry.path)) next.delete(entry.path);
                else next.add(entry.path);
                return next;
              });
              setFocusDir(entry.path);
            },
            onFileClick: (entry) => {
              onSelect(entry);
              setFocusDir(entry.path.slice(0, entry.path.lastIndexOf('/')));
            },
            onDownload: (entry) =>
              mutations.download.mutate(
                { path: entry.path, name: entry.name },
                { onError: (error) => toast.error(error.message) },
              ),
            onRename: setRenaming,
            onDelete: setDeleting,
          }}
          path={HOME}
          depth={0}
        />
      </div>

      <MkdirDialog
        open={mkdirOpen}
        onOpenChange={setMkdirOpen}
        dir={focusDir}
        mkdir={mutations.mkdir}
      />
      <RenameDialog
        entry={renaming}
        onClose={() => setRenaming(null)}
        move={mutations.move}
        onRenamed={handleRenamed}
      />
      <DeleteDialog
        entry={deleting}
        onClose={() => setDeleting(null)}
        remove={mutations.remove}
        onDeleted={handleDeleted}
      />
    </section>
  );
}
