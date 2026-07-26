import type { Template } from '@dormice/shared';
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
  Layers01Icon,
  MoreVerticalIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/DataTable';
import { paginate, TablePager } from '@/components/TablePager';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ago } from '@/features/sandboxes/format';
import { useSandboxes } from '@/features/sandboxes/hooks/useSandboxes';
import { m } from '@/paraglide/messages';
import {
  useRegisterTemplate,
  useRemoveTemplate,
  useTemplates,
} from '../hooks/useTemplates';

/**
 * 注册/升级共用一个对话框:模板是 upsert,对已有名字注册就是把它指向
 * 新镜像 — 那正是升级的正门(升级完对引用它的沙箱逐个 rebuild)。
 * 页头用 trigger 形态;表格行从「⋯」菜单打开,传受控 open — 菜单关闭
 * 即卸载,trigger 放里面会跟着消失。
 */
function RegisterTemplateDialog({
  trigger,
  initial,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger?: React.ReactElement;
  initial?: Template;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [name, setName] = useState(initial?.name ?? '');
  const [image, setImage] = useState(initial?.image ?? '');
  const mutation = useRegisterTemplate();

  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
    if (next) {
      setName(initial?.name ?? '');
      setImage(initial?.image ?? '');
      mutation.reset();
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {initial
              ? m.templates_dialog_title_update({ name: initial.name })
              : m.templates_dialog_title_register()}
          </DialogTitle>
          <DialogDescription>
            {m.templates_dialog_description()}
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
                    initial
                      ? m.templates_update_success({
                          name: template.name,
                          image: template.image,
                        })
                      : m.templates_register_success({
                          name: template.name,
                          image: template.image,
                        }),
                  );
                  setOpen(false);
                },
              },
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="template-name">
                {m.templates_field_name()}
              </FieldLabel>
              <Input
                id="template-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="python-ml"
                className="font-mono"
                disabled={initial !== undefined}
              />
              <FieldDescription>
                {m.templates_field_name_hint()}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="template-image">
                {m.templates_field_image()}
              </FieldLabel>
              <Input
                id="template-image"
                value={image}
                onChange={(event) => setImage(event.target.value)}
                placeholder="python-ml:v2"
                className="font-mono"
              />
              <FieldDescription>
                {m.templates_field_image_hint()}
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
              {initial
                ? m.templates_button_update()
                : m.templates_button_register()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveTemplateDialog({
  name,
  open,
  onOpenChange,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useRemoveTemplate();

  const remove = () =>
    mutation.mutate(name, {
      onSuccess: ({ removed }) =>
        toast.success(
          removed
            ? m.templates_remove_success({ name })
            : m.templates_remove_absent({ name }),
        ),
      // 还有沙箱引用时 daemon 回 409 并点名 name — 原文转达。
      onError: (error) => toast.error(error.message),
    });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.templates_remove_title({ name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.templates_remove_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.templates_remove_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={remove}>
            {m.common_delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * 行操作收进「⋯」菜单(风格参考 openasi 表格,2026-07-15):两个弹窗都
 * 挂在菜单外受控 — 菜单关闭即卸载,放里面会跟着消失。
 */
function TemplateRowMenu({ template }: { template: Template }) {
  const [editOpen, setEditOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={m.templates_row_actions_label({
                name: template.name,
              })}
            >
              <HugeiconsIcon icon={MoreVerticalIcon} />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <HugeiconsIcon icon={Edit02Icon} />
            {m.templates_menu_update_image()}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setRemoveOpen(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} />
            {m.common_delete()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RegisterTemplateDialog
        initial={template}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <RemoveTemplateDialog
        name={template.name}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
      />
    </>
  );
}

const PAGE_SIZE = 50;

/**
 * 模板注册表:名字 → 镜像的账本行。宿主机的 Docker daemon 就是镜像库,
 * 这一页管的只是指向;引用数从 2 秒轮询的沙箱列表现算,不发明新端点。
 */
export function TemplatesPage() {
  const templates = useTemplates();
  const sandboxes = useSandboxes().data?.sandboxes ?? [];
  const list = templates.data?.templates ?? [];
  const [page, setPage] = useState(1);
  const { rows, safePage, pageCount } = paginate(list, page, PAGE_SIZE);

  const referenceCount = (name: string) =>
    sandboxes.filter((sandbox) => sandbox.template === name).length;

  return (
    // openasi 列表页版式(2026-07-16 用户拍板):限宽居中、表格吃掉剩余
    // 高度框内滚、分页条钉底。
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-medium">{m.templates_page_title()}</h1>
        <RegisterTemplateDialog
          trigger={
            <Button size="sm">
              <HugeiconsIcon icon={Add01Icon} />
              {m.templates_register_cta()}
            </Button>
          }
        />
      </header>

      {templates.isError && (
        <Alert variant="destructive">
          <AlertDescription>{templates.error.message}</AlertDescription>
        </Alert>
      )}

      {templates.isSuccess && list.length === 0 && (
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Layers01Icon} />
            </EmptyMedia>
            <EmptyTitle>{m.templates_empty_title()}</EmptyTitle>
            <EmptyDescription>
              {m.templates_empty_description()}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {list.length > 0 && (
        <DataTable fill>
          <TableHeader>
            <TableRow>
              <TableHead>{m.templates_field_name()}</TableHead>
              <TableHead>{m.templates_field_image()}</TableHead>
              <TableHead
                className="text-right"
                title={m.templates_col_references_full()}
              >
                {m.templates_col_references()}
              </TableHead>
              <TableHead>{m.templates_col_registered()}</TableHead>
              <TableHead>{m.templates_col_updated()}</TableHead>
              <TableHead className="text-right">
                {m.templates_col_actions()}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((template) => {
              const references = referenceCount(template.name);
              return (
                <TableRow key={template.name}>
                  <TableCell className="font-mono font-medium">
                    {template.name}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {template.image}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {references > 0 ? (
                      <Link
                        to="/sandboxes"
                        className="text-foreground hover:underline"
                      >
                        {m.templates_reference_count({ n: references })}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        {m.templates_reference_count({ n: 0 })}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {ago(template.createdAt)}
                  </TableCell>
                  {/* updatedAt 只在镜像真的换过时才走动;等于 createdAt
                      = 从没升级过,直说比重复注册时间更诚实。 */}
                  <TableCell
                    className="tabular-nums text-muted-foreground"
                    title={new Date(template.updatedAt).toLocaleString()}
                  >
                    {template.updatedAt === template.createdAt
                      ? m.templates_never_upgraded()
                      : ago(template.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <TemplateRowMenu template={template} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </DataTable>
      )}

      {list.length > 0 && (
        <TablePager
          page={safePage}
          pageCount={pageCount}
          total={list.length}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
