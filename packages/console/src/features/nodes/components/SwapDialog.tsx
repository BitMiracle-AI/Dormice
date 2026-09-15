import type { NodeView } from '@dormice/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { m } from '@/paraglide/messages';
import { useUpdateNodeSettings } from '../hooks/useNodes';

/**
 * 追加 swap 弹窗:唯一的每节点旋钮(2026-09-14 集群刀 2 从设置页搬来,
 * 刀 3 在这里按台恢复)。值住在网关的 nodes 行,那台节点下一拍拿到全份
 * 后 swap.reconcile:增容立即挂上,缩容等宿主重启(运行中的 swap 块绝不
 * 卸载,server/swap.ts 的规矩)。管不了 swap 的节点(非 Linux、fake 执行
 * 器)网关会拒 400 — 读数里 managedSwap 为 null 时这里先不让提交,把原因
 * 说在输入框下面。受控弹窗:触发它的行菜单关闭即卸载。
 */
export function SwapDialog({
  node,
  open,
  onOpenChange,
}: {
  node: NodeView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [gb, setGb] = useState(String(node.swapGb));
  const mutation = useUpdateNodeSettings();
  const unsupported =
    node.reading !== null && node.reading.managedSwap === null;
  const parsed = Number(gb);
  const valid =
    gb.trim() !== '' && Number.isInteger(parsed) && parsed >= 0 && !unsupported;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) {
          setGb(String(node.swapGb));
          mutation.reset();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {m.nodes_swap_dialog_title({ id: node.id })}
          </DialogTitle>
          <DialogDescription>{m.nodes_swap_dialog_desc()}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(
              { id: node.id, swapGb: parsed },
              {
                onSuccess: () => {
                  toast.success(
                    m.nodes_swap_saved({ id: node.id, gb: parsed }),
                  );
                  onOpenChange(false);
                },
              },
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="node-swap-gb">
                {m.nodes_swap_field()}
              </FieldLabel>
              <Input
                id="node-swap-gb"
                type="number"
                min={0}
                step={1}
                value={gb}
                onChange={(event) => setGb(event.target.value)}
                disabled={unsupported}
              />
              <FieldDescription>
                {unsupported
                  ? m.nodes_swap_unsupported()
                  : m.nodes_swap_field_hint()}
              </FieldDescription>
            </Field>
            {mutation.isError && (
              <FieldError>{mutation.error.message}</FieldError>
            )}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={!valid || mutation.isPending}>
              {mutation.isPending && <Spinner />}
              {m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
