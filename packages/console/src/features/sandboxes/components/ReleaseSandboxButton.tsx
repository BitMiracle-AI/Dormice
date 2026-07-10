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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useReleaseSandbox } from '../hooks/useSandboxes';

/**
 * Release destroys the sandbox AND its disk — the one irreversible action in
 * the console, so it is the one action behind a confirmation dialog.
 */
export function ReleaseSandboxButton({
  userKey,
  onReleased,
}: {
  userKey: string;
  onReleased?: () => void;
}) {
  const mutation = useReleaseSandbox();

  const release = () =>
    mutation.mutate(userKey, {
      onSuccess: ({ released }) => {
        toast.success(
          released ? `已释放 ${userKey}` : `${userKey} 本来就不存在`,
        );
        onReleased?.();
      },
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="destructive" size="sm" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            释放
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>释放「{userKey}」?</AlertDialogTitle>
          <AlertDialogDescription>
            沙箱连同磁盘一起销毁,不可恢复。key 依然有效 — 下次 acquire
            会得到一个全新的空白沙箱。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>先留着</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={release}>
            释放
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
