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
import { m } from '@/paraglide/messages';
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
      onSuccess: () => toast.success(m.sandboxes_rebuilt_toast({ name })),
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            {m.sandboxes_rebuild()}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.sandboxes_rebuild_title({ name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.sandboxes_rebuild_desc()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.sandboxes_keep_it()}</AlertDialogCancel>
          <AlertDialogAction onClick={rebuild}>
            {m.sandboxes_rebuild()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
