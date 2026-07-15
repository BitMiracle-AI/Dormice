import { useState } from 'react';
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
import { useDestroySandbox } from '../hooks/useSandboxes';

/**
 * Destroy removes the sandbox AND its disk — the one irreversible action in
 * the console, so it is the one action behind a confirmation dialog. The
 * dialog is controlled: the detail page composes it with a red button below,
 * table rows open it from a dropdown menu item (the menu unmounts on close,
 * so the dialog must live outside it — a trigger inside would vanish).
 */
export function DestroySandboxDialog({
  externalId,
  open,
  onOpenChange,
  onDestroyed,
}: {
  externalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDestroyed?: () => void;
}) {
  const mutation = useDestroySandbox();

  const destroy = () =>
    mutation.mutate(externalId, {
      onSuccess: ({ destroyed }) => {
        toast.success(
          destroyed ? `已销毁 ${externalId}` : `${externalId} 本来就不存在`,
        );
        onDestroyed?.();
      },
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>销毁「{externalId}」?</AlertDialogTitle>
          <AlertDialogDescription>
            沙箱连同磁盘一起销毁,不可恢复。key 依然有效 — 下次 acquire
            会得到一个全新的空白沙箱。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>先留着</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={destroy}>
            销毁
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DestroySandboxButton({
  externalId,
  onDestroyed,
}: {
  externalId: string;
  onDestroyed?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        销毁
      </Button>
      <DestroySandboxDialog
        externalId={externalId}
        open={open}
        onOpenChange={setOpen}
        onDestroyed={onDestroyed}
      />
    </>
  );
}
