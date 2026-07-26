import { Add01Icon } from '@hugeicons/core-free-icons';
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
import { m } from '@/paraglide/messages';
import { useSetIngress } from '../hooks/useIngress';
import { DnsRecordGuide } from './DnsRecordGuide';

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
        toast.success(m.domains_bind_success({ domain }));
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
            {m.domains_bind_domain()}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.domains_bind_domain()}</DialogTitle>
          <DialogDescription>{m.domains_bind_description()}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGroup>
            <DnsRecordGuide
              intro={m.domains_bind_step1()}
              rows={[
                { label: m.domains_record_type(), value: 'A' },
                publicIp
                  ? {
                      label: m.domains_record_value(),
                      value: publicIp,
                      copyable: true,
                    }
                  : {
                      label: m.domains_record_value(),
                      value: m.domains_public_ip_placeholder(),
                    },
              ]}
              footnote={m.domains_record_host_hint()}
            />
            <Field data-invalid={duplicate || undefined}>
              <FieldLabel htmlFor="bind-domain">
                {m.domains_field_domain()}
              </FieldLabel>
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
                <FieldError>{m.domains_already_bound({ domain })}</FieldError>
              ) : (
                <FieldDescription>
                  {m.domains_field_domain_hint()}
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
              {m.domains_bind_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
