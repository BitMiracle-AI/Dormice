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
import { useRebuildSandbox } from '../hooks/useSandboxes';

/**
 * Rebuild swaps the container and keeps /home/user — not destructive, but it
 * does kill everything running inside and resets anything installed outside
 * the home directory, so it still asks first.
 */
export function RebuildSandboxButton({ name }: { name: string }) {
  const mutation = useRebuildSandbox();

  const rebuild = () =>
    mutation.mutate(name, {
      onSuccess: () =>
        toast.success(
          `已重建 ${name} — /home/user 保留,下次使用跑在当前镜像上`,
        ),
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            重建
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>重建「{name}」?</AlertDialogTitle>
          <AlertDialogDescription>
            换壳保盘:下次使用跑在 daemon 当前的镜像上。/home/user 一字节
            不丢;正在跑的进程和家目录之外的改动随旧壳蒸发。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>先留着</AlertDialogCancel>
          <AlertDialogAction onClick={rebuild}>重建</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
