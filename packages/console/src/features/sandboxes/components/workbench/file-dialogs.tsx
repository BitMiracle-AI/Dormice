import { useEffect, useState } from 'react';
import { toast } from 'sonner';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { m } from '@/paraglide/messages';
import type { EnvdEntry } from '../../envd-client';
import type { useFileMutations } from '../../hooks/useEnvd';

/**
 * 文件树的三个弹窗:新建文件夹 / 重命名 / 删除。受控哑组件 — mutation
 * 由树传入(树才持有 envd auth),成功路径回调回树,让树收敛选中/展开
 * 状态。重命名的目标目录从 entry.path 自己算 dirname,不依赖"当前
 * 路径"概念(树没有单一当前路径,只有焦点目录)。
 */
type Mutations = ReturnType<typeof useFileMutations>;

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

export function MkdirDialog({
  open,
  onOpenChange,
  dir,
  mkdir,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 新文件夹落在哪:树的焦点目录。 */
  dir: string;
  mkdir: Mutations['mkdir'];
}) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{m.workbench_mkdir_title()}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mkdir.mutate(`${dir}/${name}`, {
              onSuccess: () => onOpenChange(false),
              onError: (error) => toast.error(error.message),
            });
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={m.workbench_folder_name()}
            className="font-mono"
          />
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={name === '' || mkdir.isPending}>
              {mkdir.isPending && <Spinner />}
              {m.workbench_create()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameDialog({
  entry,
  onClose,
  move,
  onRenamed,
}: {
  /** 正在重命名的条目;null = 关闭。 */
  entry: EnvdEntry | null;
  onClose: () => void;
  move: Mutations['move'];
  onRenamed: (source: string, destination: string) => void;
}) {
  const [renameTo, setRenameTo] = useState('');
  useEffect(() => {
    if (entry) setRenameTo(entry.name);
  }, [entry]);

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {m.workbench_rename_title({ name: entry?.name ?? '' })}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!entry) return;
            const destination = `${dirnameOf(entry.path)}/${renameTo}`;
            move.mutate(
              { source: entry.path, destination },
              {
                onSuccess: () => {
                  onRenamed(entry.path, destination);
                  onClose();
                },
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
                renameTo === '' || renameTo === entry?.name || move.isPending
              }
            >
              {move.isPending && <Spinner />}
              {m.workbench_rename()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDialog({
  entry,
  onClose,
  remove,
  onDeleted,
}: {
  /** 正在删除的条目;null = 关闭。 */
  entry: EnvdEntry | null;
  onClose: () => void;
  remove: Mutations['remove'];
  onDeleted: (path: string) => void;
}) {
  return (
    <AlertDialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.workbench_delete_title({ name: entry?.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {entry?.type === 'FILE_TYPE_DIRECTORY'
              ? m.workbench_delete_desc_dir()
              : m.workbench_delete_desc()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.workbench_keep_it()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (!entry) return;
              remove.mutate(entry.path, {
                onSuccess: () => {
                  onDeleted(entry.path);
                  onClose();
                },
                onError: (error) => toast.error(error.message),
              });
            }}
          >
            {m.common_delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
