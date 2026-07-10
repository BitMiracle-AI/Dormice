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
export function RebuildSandboxButton({ userKey }: { userKey: string }) {
  const mutation = useRebuildSandbox();

  const rebuild = () =>
    mutation.mutate(userKey, {
      onSuccess: () =>
        toast.success(
          `Rebuilt ${userKey} — /home/user kept; its next use starts on the current base image`,
        ),
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            Rebuild
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rebuild “{userKey}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Swaps the container so the next use starts on the daemon’s current
            base image. Everything in /home/user is kept; running processes and
            changes outside it are gone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={rebuild}>Rebuild</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
