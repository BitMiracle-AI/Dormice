import { bareHostnameRegex } from '@dormice/shared';
import { Add01Icon, PencilEdit02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';
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
import { useConfig } from '@/features/settings/hooks/useConfig';
import { useUpdateSettings } from '@/features/settings/hooks/useUpdateSettings';
import { m } from '@/paraglide/messages';
import { DnsRecordGuide } from './DnsRecordGuide';

/**
 * 沙箱域名卡:端口预览(getHost)的泛域名,住在账本设置里、改了立即
 * 生效 — 与控制台域名(托管 Caddyfile)是两套机制,所以这张卡不依赖
 * DORMICE_INGRESS_FILE,绝不能被"未接管反向代理"的空态挡住。指引块
 * 与控制台域名绑定共用一份(DnsRecordGuide 的体验对齐):要加的是一条
 * 泛解析 A 记录。诚实边界:预览默认走 HTTP;泛域名 HTTPS 证书要在
 * 反向代理层自配,不在本页管理范围。
 */

function SetDialog({
  current,
  publicIp,
  trigger,
}: {
  current: string | null;
  publicIp: string | null;
  trigger: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const { pending, error, setError, submit } = useUpdateSettings(() =>
    setOpen(false),
  );

  const domain = draft.trim().toLowerCase();
  const valid = bareHostnameRegex.test(domain);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDraft(current ?? '');
          setError(null);
        }
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.domains_sandbox_dialog_title()}</DialogTitle>
          <DialogDescription>
            {m.domains_sandbox_dialog_desc()}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              { sandboxDomain: domain },
              m.domains_sandbox_saved({ domain }),
            );
          }}
        >
          <FieldGroup>
            <DnsRecordGuide
              intro={m.domains_sandbox_record_intro()}
              rows={[
                {
                  label: m.domains_sandbox_record_host(),
                  value: `*.${domain || m.domains_sandbox_field_placeholder()}`,
                },
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
              footnote={m.domains_sandbox_record_hint()}
            />
            <Field>
              <FieldLabel htmlFor="sandbox-domain">
                {m.domains_sandbox_field_label()}
              </FieldLabel>
              <Input
                id="sandbox-domain"
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={m.domains_sandbox_field_placeholder()}
                className="font-mono"
              />
              <FieldDescription>
                {m.domains_field_domain_hint()}
              </FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={!valid || pending}>
              {pending && <Spinner />}
              {m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SandboxDomainCard({ publicIp }: { publicIp: string | null }) {
  const { data, isPending } = useConfig();
  const clear = useUpdateSettings(() => {});
  const domain = data?.settings.sandboxDomain ?? null;

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium">
          {m.domains_sandbox_card_title()}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {m.domains_sandbox_card_desc()}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        {isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {m.settings_loading_config()}
          </div>
        ) : domain ? (
          <>
            <div className="min-w-0">
              <div className="truncate font-mono text-sm" title={domain}>
                {domain}
              </div>
              <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {m.domains_sandbox_url_shape({ domain })}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <SetDialog
                current={domain}
                publicIp={publicIp}
                trigger={
                  <Button variant="outline" size="sm">
                    <HugeiconsIcon icon={PencilEdit02Icon} />
                    {m.common_edit()}
                  </Button>
                }
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={clear.pending}
                onClick={() =>
                  void clear.submit(
                    { sandboxDomain: null },
                    m.domains_sandbox_cleared(),
                  )
                }
              >
                {clear.pending && <Spinner />}
                {m.domains_sandbox_clear()}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-muted-foreground">
              {m.domains_sandbox_not_set()}
            </div>
            <SetDialog
              current={null}
              publicIp={publicIp}
              trigger={
                <Button variant="outline" size="sm">
                  <HugeiconsIcon icon={Add01Icon} />
                  {m.domains_sandbox_set()}
                </Button>
              }
            />
          </>
        )}
      </div>
    </section>
  );
}
