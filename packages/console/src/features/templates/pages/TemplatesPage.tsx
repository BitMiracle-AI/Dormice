import type { Template } from '@dormice/shared';
import { Add01Icon, Layers01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { since } from '@/features/sandboxes/format';
import { useSandboxes } from '@/features/sandboxes/hooks/useSandboxes';
import {
  useRegisterTemplate,
  useRemoveTemplate,
  useTemplates,
} from '../hooks/useTemplates';

/**
 * 注册/升级共用一个对话框:模板是 upsert,对已有名字注册就是把它指向
 * 新镜像 — 那正是升级的正门(升级完对引用它的沙箱逐个 rebuild)。
 */
function RegisterTemplateDialog({
  trigger,
  initial,
}: {
  trigger: React.ReactElement;
  initial?: Template;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initial?.name ?? '');
  const [image, setImage] = useState(initial?.image ?? '');
  const mutation = useRegisterTemplate();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName(initial?.name ?? '');
          setImage(initial?.image ?? '');
          mutation.reset();
        }
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {initial ? `更新「${initial.name}」指向的镜像` : '注册模板'}
          </DialogTitle>
          <DialogDescription>
            模板 = 一个名字 + 宿主机上已有的 Docker 镜像。注册是配置,
            镜像可以晚点再 build — 缺席时创建沙箱会得到点名的报错。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(
              { name, image },
              {
                onSuccess: ({ template }) => {
                  toast.success(
                    `模板「${template.name}」→ ${template.image}` +
                      (initial
                        ? ' — 还在旧镜像上的沙箱在列表里带「可升级」标记,逐个 Rebuild'
                        : ''),
                  );
                  setOpen(false);
                },
              },
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="template-name">名字</FieldLabel>
              <Input
                id="template-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="python-ml"
                className="font-mono"
                disabled={initial !== undefined}
              />
              <FieldDescription>
                同时也是 E2B 的 templateID;「base」保留,恒指基础镜像。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="template-image">镜像</FieldLabel>
              <Input
                id="template-image"
                value={image}
                onChange={(event) => setImage(event.target.value)}
                placeholder="python-ml:v2"
                className="font-mono"
              />
              <FieldDescription>
                宿主机 Docker 里的镜像引用。重新注册同名模板 = 指向新镜像 =
                模板升级。
              </FieldDescription>
            </Field>
            {mutation.isError && (
              <FieldError>{mutation.error.message}</FieldError>
            )}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button
              type="submit"
              disabled={name === '' || image === '' || mutation.isPending}
            >
              {mutation.isPending && <Spinner />}
              {initial ? '更新' : '注册'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveTemplateButton({ name }: { name: string }) {
  const mutation = useRemoveTemplate();

  const remove = () =>
    mutation.mutate(name, {
      onSuccess: ({ removed }) =>
        toast.success(
          removed ? `已删除「${name}」` : `「${name}」本来就不存在`,
        ),
      // 还有沙箱引用时 daemon 回 409 并点名 externalId — 原文转达。
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="destructive" size="sm" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            删除
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除模板「{name}」?</AlertDialogTitle>
          <AlertDialogDescription>
            只删注册项,不动镜像本身。还有沙箱引用时 daemon 会拒绝并点名。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>先留着</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={remove}>
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * 模板注册表:名字 → 镜像的账本行。宿主机的 Docker daemon 就是镜像库,
 * 这一页管的只是指向;引用数从 2 秒轮询的沙箱列表现算,不发明新端点。
 */
export function TemplatesPage() {
  const templates = useTemplates();
  const sandboxes = useSandboxes().data?.sandboxes ?? [];
  const list = templates.data?.templates ?? [];

  const referenceCount = (name: string) =>
    sandboxes.filter((sandbox) => sandbox.template === name).length;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">模板</h1>
          <p className="text-sm text-muted-foreground">
            模板 = 命名的 Docker 镜像。名字即 E2B 的 templateID,重新注册
            即升级。
          </p>
        </div>
        <RegisterTemplateDialog
          trigger={
            <Button size="sm">
              <HugeiconsIcon icon={Add01Icon} />
              注册模板
            </Button>
          }
        />
      </div>

      {templates.isError && (
        <Alert variant="destructive">
          <AlertDescription>{templates.error.message}</AlertDescription>
        </Alert>
      )}

      {templates.isSuccess && list.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Layers01Icon} />
            </EmptyMedia>
            <EmptyTitle>还没有注册模板</EmptyTitle>
            <EmptyDescription>
              没有模板时沙箱一律用 daemon 的基础镜像。在宿主机 build 一个
              镜像,再到这里给它起个名字。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {list.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名字</TableHead>
                <TableHead>镜像</TableHead>
                <TableHead>引用沙箱</TableHead>
                <TableHead>注册于</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((template) => {
                const references = referenceCount(template.name);
                return (
                  <TableRow key={template.name}>
                    <TableCell className="font-mono font-medium">
                      {template.name}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">
                      {template.image}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {references > 0 ? (
                        <Link
                          to="/sandboxes"
                          className="text-foreground hover:underline"
                        >
                          {references} 个
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">0 个</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {since(template.createdAt)}前
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-2">
                        <RegisterTemplateDialog
                          initial={template}
                          trigger={
                            <Button variant="outline" size="sm">
                              更新镜像
                            </Button>
                          }
                        />
                        <RemoveTemplateButton name={template.name} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
