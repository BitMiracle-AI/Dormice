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
import { m } from '@/paraglide/messages';
import { useDestroySandbox } from '../hooks/useSandboxes';

/**
 * Destroy removes the sandbox AND its disk — the one irreversible action in
 * the console, so it is the one action behind a confirmation dialog. The
 * dialog is controlled: the detail page composes it with a red button below,
 * table rows open it from a dropdown menu item (the menu unmounts on close,
 * so the dialog must live outside it — a trigger inside would vanish).
 */
export function DestroySandboxDialog({
  name,
  open,
  onOpenChange,
  onDestroyed,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDestroyed?: () => void;
}) {
  const mutation = useDestroySandbox();

  const destroy = () =>
    mutation.mutate(name, {
      onSuccess: ({ destroyed }) => {
        toast.success(
          destroyed
            ? m.sandboxes_destroyed_toast({ name })
            : m.sandboxes_already_gone_toast({ name }),
        );
        onDestroyed?.();
      },
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.sandboxes_destroy_title({ name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.sandboxes_destroy_desc()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.sandboxes_keep_it()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={destroy}>
            {m.sandboxes_destroy()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DestroySandboxButton({
  name,
  onDestroyed,
}: {
  name: string;
  onDestroyed?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        {m.sandboxes_destroy()}
      </Button>
      <DestroySandboxDialog
        name={name}
        open={open}
        onOpenChange={setOpen}
        onDestroyed={onDestroyed}
      />
    </>
  );
}
