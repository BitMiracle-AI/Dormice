import type { IngressDomainStatus, IngressProbe } from '@dormice/shared';
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle01Icon,
  Globe02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { useIngress, useSetIngress } from '../hooks/useIngress';

/**
 * 每个域名此刻的收敛阶段,从两个探测推出来:绿 = 事实成立,黄 = 还没
 * 成立(等待中,不是故障),红 = 探测本身失败。探测是 daemon 请求时现
 * 测的,不是缓存 — 没收敛的域名每 5s 轮询,页面上的进度是真的。
 */
type DomainPhase = 'ready' | 'issuing' | 'waiting-dns' | 'dns-error';

function phaseOf(probe: IngressProbe): DomainPhase {
  if (probe.tlsOk) return 'ready';
  if (probe.dnsError) return 'dns-error';
  if (probe.dnsAddresses.length === 0) return 'waiting-dns';
  return 'issuing';
}

const PHASE_BADGES: Record<DomainPhase, { label: string; className: string }> =
  {
    ready: {
      label: 'HTTPS 已就绪',
      className:
        'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    },
    issuing: {
      label: '证书签发中',
      className:
        'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
    },
    'waiting-dns': {
      label: '等待 DNS 解析',
      className:
        'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    },
    'dns-error': {
      label: 'DNS 查询失败',
      className:
        'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
    },
  };

function describeProbe(probe: IngressProbe, phase: DomainPhase): string {
  const resolved = `已解析到 ${probe.dnsAddresses.join(', ')}`;
  switch (phase) {
    case 'ready':
      return `${resolved};证书已签发,HTTPS 正常服务`;
    case 'issuing':
      return `${resolved};Caddy 正在申请证书 — 自动重试,通常一分钟内完成`;
    case 'waiting-dns':
      return '还没有解析记录 — 去域名商处加一条 A 记录指向本机公网 IP,生效通常要几分钟';
    case 'dns-error':
      return '解析器查询失败(超时或上游故障),会随下一轮探测自动重试';
  }
}

/** 探测的原话(证书报错/解析报错),等待阶段的排障线索。 */
function probeErrorLine(
  probe: IngressProbe,
  phase: DomainPhase,
): string | null {
  if (phase === 'issuing') return probe.tlsError;
  if (phase === 'dns-error') return probe.dnsError;
  return null;
}

function DomainItem({
  status,
  removing,
  busy,
  onRemove,
}: {
  status: IngressDomainStatus;
  /** 正在解绑的是不是本行(行内 spinner 只亮在被点的那行)。 */
  removing: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const phase = phaseOf(status.probe);
  const badge = PHASE_BADGES[phase];
  const errorLine = probeErrorLine(status.probe, phase);
  // 正从这个域名访问控制台:不用再"打开",解绑等于拆自己脚下的梯子,
  // 但 :80 的 IP 访问兜底还在,所以只标注、不禁止。
  const isHere = window.location.hostname === status.domain;

  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        {phase === 'ready' ? (
          <HugeiconsIcon
            icon={CheckmarkCircle01Icon}
            className="text-emerald-600 dark:text-emerald-400"
          />
        ) : phase === 'issuing' ? (
          <Spinner className="text-sky-600 dark:text-sky-400" />
        ) : (
          <HugeiconsIcon
            icon={Alert02Icon}
            className={
              phase === 'dns-error'
                ? 'text-red-600 dark:text-red-400'
                : 'text-amber-600 dark:text-amber-400'
            }
          />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-2 font-mono">
          {status.domain}
          <Badge variant="outline" className={badge.className}>
            {badge.label}
          </Badge>
          {isHere && <Badge variant="secondary">当前访问</Badge>}
        </ItemTitle>
        <ItemDescription>{describeProbe(status.probe, phase)}</ItemDescription>
        {errorLine && (
          <div className="font-mono text-xs text-muted-foreground">
            {errorLine}
          </div>
        )}
      </ItemContent>
      <ItemActions>
        {phase === 'ready' && !isHere && (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            // 新标签页:换源意味着 cookie 换域,要重新登录 — 别把当前会话跳丢。
            render={
              <a
                href={`https://${status.domain}/console/`}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            打开
            <HugeiconsIcon icon={ArrowUpRight01Icon} />
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
          {removing && <Spinner />}
          解绑
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * 域名页:setIngress 改写 daemon 托管的 Caddy 配置并热重载,证书全权
 * 归 Caddy(ACME)。wire 是集合语义 — 增删都是"把想要的完整清单发过
 * 去",页面在已绑清单上加一个/减一个再整体提交。绑定失败不锁门:
 * :80 的 IP 访问在每次改写里都保留。
 */
export function DomainsPage() {
  const { data, isPending, isError, error } = useIngress();
  const mutation = useSetIngress();
  const [draft, setDraft] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);

  const statuses = data?.domains ?? [];
  const bound = statuses.map((entry) => entry.domain);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const domain = draft.trim().toLowerCase();
    if (domain.length === 0) return;
    if (bound.includes(domain)) {
      toast.info(`${domain} 已经绑定`);
      return;
    }
    mutation.mutate([...bound, domain], {
      onSuccess: () => {
        setDraft('');
        toast.success(`已绑定 ${domain},等待证书签发`);
      },
      onError: (mutationError) => toast.error(mutationError.message),
    });
  };

  const remove = (domain: string) => {
    setRemoving(domain);
    mutation.mutate(
      bound.filter((entry) => entry !== domain),
      {
        onSuccess: () => toast.success(`已解绑 ${domain}`),
        onError: (mutationError) => toast.error(mutationError.message),
        onSettled: () => setRemoving(null),
      },
    );
  };

  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">域名</h1>
        <p className="text-sm text-muted-foreground">
          给控制台(和 API)绑定域名,HTTPS
          证书自动申请与续期。可以绑多个;无论绑定成败,IP
          访问始终保留,不会被锁在门外。
        </p>
      </div>

      {isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> 读取域名配置…
        </div>
      ) : isError ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>读取失败</EmptyTitle>
            <EmptyDescription>{error.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !data.managed ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Globe02Icon} />
            </EmptyMedia>
            <EmptyTitle>本 daemon 未接管反向代理</EmptyTitle>
            <EmptyDescription>
              DORMICE_INGRESS_FILE 未配置,网页绑定不可用。重跑 install.sh
              会自动装配 Caddy 并打开这里;或继续自行维护你的代理配置。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {statuses.length > 0 && (
            <ItemGroup className="gap-2">
              {statuses.map((status) => (
                <DomainItem
                  key={status.domain}
                  status={status}
                  removing={removing === status.domain}
                  busy={mutation.isPending}
                  onRemove={() => remove(status.domain)}
                />
              ))}
            </ItemGroup>
          )}

          <Card>
            <CardHeader>
              <CardTitle>
                {statuses.length === 0 ? '绑定第一个域名' : '再绑一个域名'}
              </CardTitle>
              <CardDescription>
                三步:去域名商处加一条 A 记录指向本机公网 IP → 在这里绑定 →
                证书自动申请与续期,无需手动配置。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-3" onSubmit={add}>
                <Field>
                  <FieldLabel htmlFor="ingress-domain">域名</FieldLabel>
                  <Input
                    id="ingress-domain"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="console.example.com"
                    className="max-w-md font-mono"
                  />
                  <FieldDescription>
                    裸主机名,不带 http:// 前缀和端口。
                  </FieldDescription>
                </Field>
                <div>
                  <Button
                    type="submit"
                    disabled={draft.trim().length === 0 || mutation.isPending}
                  >
                    {mutation.isPending && removing === null && <Spinner />}
                    绑定
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {statuses.length > 0 && (
            <p className="text-sm text-muted-foreground">
              以上探测跑在服务器本机,证明不了公网可达:若浏览器打不开 HTTPS
              地址,通常是云安全组还没放行 443 端口;中国大陆机房还需域名有 ICP
              备案,否则云厂商会在入口拦截(与本机配置无关)。
            </p>
          )}
        </>
      )}
    </>
  );
}
