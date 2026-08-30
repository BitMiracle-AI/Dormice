import type { UpdateSettingsRequest } from '@dormice/shared';
import { bareHostnameRegex } from '@dormice/shared';
import { Add01Icon, PencilEdit02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { useConfig } from '@/features/settings/hooks/useConfig';
import { useUpdateSettings } from '@/features/settings/hooks/useUpdateSettings';
import { updateSettings } from '@/lib/api';
import { m } from '@/paraglide/messages';
import { DnsRecordGuide } from './DnsRecordGuide';

/**
 * 沙箱域名卡:端口预览(getHost)的域名组,住在账本设置里、改了立即
 * 生效 — 与控制台域名(托管 Caddyfile)是两套机制,所以这张卡不依赖
 * DORMICE_INGRESS_FILE,绝不能被"未接管反向代理"的空态挡住。
 *
 * 域名组 = 规范域名 + 别名列表:别名只参与入站匹配,新生成的预览网址
 * 与 E2B getHost() 恒用规范域名 — 生产换域名的正路是「添加别名 → 等
 * 泛解析生效 → 设为规范」,一次原子交换后旧域名留在别名里,存量网址
 * 一个不断;规范行的「编辑」是纯替换,修 typo 用。指引块与控制台域名
 * 绑定共用一份(DnsRecordGuide 的体验对齐):每个域名都要一条泛解析
 * A 记录。诚实边界:预览默认走 HTTP;泛域名 HTTPS 证书要在反向代理层
 * 自配,不在本页管理范围。
 */

function DomainDialog({
  title,
  description,
  fieldLabel,
  inputId,
  current,
  taken,
  publicIp,
  trigger,
  buildPatch,
  successMessage,
}: {
  title: string;
  description: string;
  fieldLabel: string;
  inputId: string;
  /** 预填值(编辑规范域名);添加别名传 null。 */
  current: string | null;
  /** 已被占用的域名(小写),命中即就地拒绝 — 服务端守卫的前端回声。 */
  taken: string[];
  publicIp: string | null;
  trigger: React.ReactElement;
  buildPatch: (domain: string) => UpdateSettingsRequest;
  successMessage: (domain: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const { pending, error, setError, submit } = useUpdateSettings(() =>
    setOpen(false),
  );

  const domain = draft.trim().toLowerCase();
  const duplicate = domain.length > 0 && taken.includes(domain);
  const valid = bareHostnameRegex.test(domain) && !duplicate;

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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(buildPatch(domain), successMessage(domain));
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
            <Field data-invalid={duplicate || undefined}>
              <FieldLabel htmlFor={inputId}>{fieldLabel}</FieldLabel>
              <Input
                id={inputId}
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={m.domains_sandbox_field_placeholder()}
                className="font-mono"
              />
              <FieldDescription>
                {m.domains_field_domain_hint()}
              </FieldDescription>
              {duplicate && (
                <FieldError>
                  {m.domains_sandbox_alias_duplicate({ domain })}
                </FieldError>
              )}
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
  const queryClient = useQueryClient();
  // 行内动作(设为规范/移除/全部清除)不在弹窗里,错误走 toast 报告;
  // busy 记住被点的那个动作,spinner 只亮在它身上。
  const [busy, setBusy] = useState<string | null>(null);
  const domain = data?.settings.sandboxDomain ?? null;
  const aliases = data?.settings.sandboxDomainAliases ?? [];
  const takenLower = [domain, ...aliases]
    .filter((entry): entry is string => entry !== null)
    .map((entry) => entry.toLowerCase());

  const act = async (
    key: string,
    patch: UpdateSettingsRequest,
    done: string,
  ) => {
    setBusy(key);
    try {
      await updateSettings(patch);
      toast.success(done);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // 失败也刷新 — 与 useUpdateSettings 同一条理由。
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      setBusy(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">
            {m.domains_sandbox_card_title()}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {m.domains_sandbox_card_desc()}
          </p>
        </div>
        {domain && (
          <div className="flex shrink-0 items-center gap-1">
            <DomainDialog
              title={m.domains_sandbox_alias_dialog_title()}
              description={m.domains_sandbox_alias_dialog_desc()}
              fieldLabel={m.domains_sandbox_alias_field_label()}
              inputId="sandbox-domain-alias"
              current={null}
              taken={takenLower}
              publicIp={publicIp}
              buildPatch={(next) => ({
                sandboxDomainAliases: [...aliases, next],
              })}
              successMessage={(next) =>
                m.domains_sandbox_alias_added({ domain: next })
              }
              trigger={
                <Button variant="outline" size="sm">
                  <HugeiconsIcon icon={Add01Icon} />
                  {m.domains_sandbox_alias_add()}
                </Button>
              }
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void act(
                  'clear',
                  // 守卫要求成套清:留着别名的规范域名清除会被 400。
                  { sandboxDomain: null, sandboxDomainAliases: [] },
                  m.domains_sandbox_cleared(),
                )
              }
            >
              {busy === 'clear' && <Spinner />}
              {m.domains_sandbox_clear()}
            </Button>
          </div>
        )}
      </div>
      <div className="px-4 py-3">
        {isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {m.settings_loading_config()}
          </div>
        ) : domain ? (
          <ItemGroup className="gap-2">
            <Item variant="outline">
              <ItemContent>
                <ItemTitle className="flex flex-wrap items-center gap-2 font-mono">
                  {domain}
                  <Badge variant="secondary">
                    {m.domains_sandbox_badge_canonical()}
                  </Badge>
                </ItemTitle>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {m.domains_sandbox_url_shape({ domain })}
                </div>
              </ItemContent>
              <ItemActions>
                <DomainDialog
                  title={m.domains_sandbox_dialog_title()}
                  description={m.domains_sandbox_dialog_desc()}
                  fieldLabel={m.domains_sandbox_field_label()}
                  inputId="sandbox-domain"
                  current={domain}
                  taken={aliases.map((alias) => alias.toLowerCase())}
                  publicIp={publicIp}
                  buildPatch={(next) => ({ sandboxDomain: next })}
                  successMessage={(next) =>
                    m.domains_sandbox_saved({ domain: next })
                  }
                  trigger={
                    <Button variant="outline" size="sm">
                      <HugeiconsIcon icon={PencilEdit02Icon} />
                      {m.common_edit()}
                    </Button>
                  }
                />
              </ItemActions>
            </Item>
            {aliases.map((alias) => (
              <Item key={alias} variant="outline">
                <ItemContent>
                  <ItemTitle className="font-mono">{alias}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        `canonical:${alias}`,
                        // 原子交换:别名上位,原规范落回别名 — 两边的
                        // 存量网址都继续可用。
                        {
                          sandboxDomain: alias,
                          sandboxDomainAliases: [
                            domain,
                            ...aliases.filter((entry) => entry !== alias),
                          ],
                        },
                        m.domains_sandbox_made_canonical({ domain: alias }),
                      )
                    }
                  >
                    {busy === `canonical:${alias}` && <Spinner />}
                    {m.domains_sandbox_make_canonical()}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        `remove:${alias}`,
                        {
                          sandboxDomainAliases: aliases.filter(
                            (entry) => entry !== alias,
                          ),
                        },
                        m.domains_sandbox_alias_removed({ domain: alias }),
                      )
                    }
                  >
                    {busy === `remove:${alias}` && <Spinner />}
                    {m.domains_sandbox_alias_remove()}
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              {m.domains_sandbox_not_set()}
            </div>
            <DomainDialog
              title={m.domains_sandbox_dialog_title()}
              description={m.domains_sandbox_dialog_desc()}
              fieldLabel={m.domains_sandbox_field_label()}
              inputId="sandbox-domain"
              current={null}
              taken={[]}
              publicIp={publicIp}
              buildPatch={(next) => ({ sandboxDomain: next })}
              successMessage={(next) =>
                m.domains_sandbox_saved({ domain: next })
              }
              trigger={
                <Button variant="outline" size="sm">
                  <HugeiconsIcon icon={Add01Icon} />
                  {m.domains_sandbox_set()}
                </Button>
              }
            />
          </div>
        )}
      </div>
    </section>
  );
}
