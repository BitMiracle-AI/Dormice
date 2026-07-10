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
          released ? `Released ${userKey}` : `${userKey} was already gone`,
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
            Release
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Release “{userKey}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This destroys the sandbox and its disk. The key stays valid — the
            next acquire starts from a blank sandbox.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={release}>
            Release
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
