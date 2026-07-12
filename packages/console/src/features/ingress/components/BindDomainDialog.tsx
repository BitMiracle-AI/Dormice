import { Add01Icon, Copy01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
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
  DialogTrigger,
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
import { copyText } from '@/lib/copy';
import { useSetIngress } from '../hooks/useIngress';

/**
 * 绑定就是"照抄一条 A 记录":弹窗把要填的记录值(本机公网 IP)直接给
 * 出来带复制按钮,用户不用猜。wire 是集合语义 — 提交的是已绑清单加
 * 这一个;失败留在弹窗里就地报错,成功关窗回列表看进度。
 */
export function BindDomainDialog({
  bound,
  publicIp,
}: {
  bound: string[];
  /** 页面探测到的本机公网 IP;拿不到时(如 dev 环境)诚实退化为占位文案。 */
  publicIp: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const mutation = useSetIngress();

  const domain = draft.trim().toLowerCase();
  const duplicate = domain.length > 0 && bound.includes(domain);

  const reset = () => {
    setDraft('');
    mutation.reset();
  };

  const submit = () => {
    mutation.mutate([...bound, domain], {
      onSuccess: () => {
        toast.success(`已绑定 ${domain},证书自动申请中`);
        setOpen(false);
        reset();
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <HugeiconsIcon icon={Add01Icon} />
            绑定域名
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>绑定域名</DialogTitle>
          <DialogDescription>
            HTTPS 证书自动申请与续期,无需手动配置;无论绑定成败,IP
            访问始终保留,不会被锁在门外。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGroup>
            <div className="rounded-md border bg-muted/30 px-4 py-3">
              <p className="text-xs text-muted-foreground">
                第一步:去域名商处给这个域名加一条解析记录(生效通常要
                几分钟;先绑定也行,页面会等它转绿):
              </p>
              <div className="mt-2 grid grid-cols-[4.5rem_1fr] items-center gap-y-1 font-mono text-xs">
                <span className="text-muted-foreground">类型</span>
                <span>A</span>
                <span className="text-muted-foreground">记录值</span>
                {publicIp ? (
                  <span className="flex items-center gap-1">
                    {publicIp}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="复制 IP"
                      onClick={() =>
                        copyText(publicIp).then(
                          () => toast.success('已复制'),
                          () => toast.error('复制失败 — 请手动选中文本'),
                        )
                      }
                    >
                      <HugeiconsIcon icon={Copy01Icon} />
                    </Button>
                  </span>
                ) : (
                  <span>本机公网 IP</span>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                主机记录(名称)填子域前缀,绑定主域名本身则填 @。
              </p>
            </div>
            <Field data-invalid={duplicate || undefined}>
              <FieldLabel htmlFor="bind-domain">域名</FieldLabel>
              <Input
                id="bind-domain"
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="console.example.com"
                className="font-mono"
                aria-invalid={duplicate || undefined}
              />
              {duplicate ? (
                <FieldError>{domain} 已经绑定</FieldError>
              ) : (
                <FieldDescription>
                  裸主机名,不带 http:// 前缀和端口。
                </FieldDescription>
              )}
            </Field>
            {mutation.isError && (
              <FieldError>{mutation.error.message}</FieldError>
            )}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button
              type="submit"
              disabled={domain.length === 0 || duplicate || mutation.isPending}
            >
              {mutation.isPending && <Spinner />}
              绑定
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
