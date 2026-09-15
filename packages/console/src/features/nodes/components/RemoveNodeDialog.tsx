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
import { m } from '@/paraglide/messages';
import { useRemoveNode } from '../hooks/useNodes';

/**
 * 移除节点的确认:「它永远不回来了」的声明,不是停机。网关自己把关 —
 * 还在报到的节点拒 409 并说明为什么(先停 daemon、等两个间隔),原话
 * 就地 toast;误删的节点下次报到自动回来,所以这里不需要二次确认。
 */
export function RemoveNodeDialog({
  id,
  open,
  onOpenChange,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useRemoveNode();
  const remove = () =>
    mutation.mutate(id, {
      onSuccess: ({ removed }) =>
        toast.success(
          removed
            ? m.nodes_remove_success({ id })
            : m.nodes_remove_absent({ id }),
        ),
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.nodes_remove_title({ id })}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.nodes_remove_desc()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={remove}>
            {m.nodes_menu_remove()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
