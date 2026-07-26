import type { IngressDomainStatus, IngressProbe } from '@dormice/shared';
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle01Icon,
  Globe02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
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
import { m } from '@/paraglide/messages';
import { BindDomainDialog } from '../components/BindDomainDialog';
import { useIngress, useSetIngress } from '../hooks/useIngress';

/**
 * 每个域名此刻的收敛阶段,从两个探测推出来:绿 = 事实成立,黄 = 还没
 * 成立(等待中,不是故障),红 = 有明确的错处。探测是 daemon 请求时现
 * 测的,不是缓存 — 没收敛的域名每 5s 轮询,页面上的进度是真的。
 *
 * dns-mismatch 是诊断价值最高的一档:A 记录指到了别的 IP 时,证书永
 * 远签不出来 — 没有这一档它会假装成"签发中"无限转圈。只在确知本机
 * 公网 IP 时才敢下这个判断,拿不到就退回"签发中",不装懂。
 */
type DomainPhase =
  | 'ready'
  | 'issuing'
  | 'waiting-dns'
  | 'dns-mismatch'
  | 'dns-error';

function phaseOf(probe: IngressProbe, publicIp: string | null): DomainPhase {
  if (probe.tlsOk) return 'ready';
  if (probe.dnsError) return 'dns-error';
  if (probe.dnsAddresses.length === 0) return 'waiting-dns';
  if (publicIp && !probe.dnsAddresses.includes(publicIp)) return 'dns-mismatch';
  return 'issuing';
}

/**
 * 本机公网 IP 的来源是"浏览器此刻怎么够到这台服务器"——这比 daemon
 * 自己猜可靠(云上 NAT 环境 daemon 只看得见内网地址):引导期直接用
 * IP 访问,地址栏就是答案;已经走域名访问,当前域名(或任一绿灯域名)
 * 的解析值就是答案。两个来源都没有(如 localhost dev)则诚实返回 null。
 */
function detectPublicIp(statuses: IngressDomainStatus[]): string | null {
  const host = window.location.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const here = statuses.find(
    (status) => status.domain === host && status.probe.dnsAddresses.length > 0,
  );
  const ready = statuses.find(
    (status) => status.probe.tlsOk && status.probe.dnsAddresses.length > 0,
  );
  return (here ?? ready)?.probe.dnsAddresses[0] ?? null;
}

const PHASE_BADGES: Record<
  DomainPhase,
  { label: () => string; className: string }
> = {
  ready: {
    label: m.domains_phase_ready,
    className:
      'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  issuing: {
    label: m.domains_phase_issuing,
    className: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  },
  'waiting-dns': {
    label: m.domains_phase_waiting_dns,
    className:
      'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  'dns-mismatch': {
    label: m.domains_phase_dns_mismatch,
    className: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  },
  'dns-error': {
    label: m.domains_phase_dns_error,
    className: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  },
};

function describeProbe(
  probe: IngressProbe,
  phase: DomainPhase,
  publicIp: string | null,
): string {
  const addresses = probe.dnsAddresses.join(', ');
  switch (phase) {
    case 'ready':
      return m.domains_probe_ready({ addresses });
    case 'issuing':
      return m.domains_probe_issuing({ addresses });
    case 'waiting-dns':
      return m.domains_probe_waiting_dns();
    case 'dns-mismatch':
      return m.domains_probe_dns_mismatch({
        addresses,
        publicIp: publicIp ?? '',
      });
    case 'dns-error':
      return m.domains_probe_dns_error();
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
  publicIp,
  removing,
  busy,
  onRemove,
}: {
  status: IngressDomainStatus;
  publicIp: string | null;
  /** 正在解绑的是不是本行(行内 spinner 只亮在被点的那行)。 */
  removing: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const phase = phaseOf(status.probe, publicIp);
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
              phase === 'waiting-dns'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-red-600 dark:text-red-400'
            }
          />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-2 font-mono">
          {status.domain}
          <Badge variant="outline" className={badge.className}>
            {badge.label()}
          </Badge>
          {isHere && (
            <Badge variant="secondary">{m.domains_badge_current()}</Badge>
          )}
        </ItemTitle>
        <ItemDescription>
          {describeProbe(status.probe, phase, publicIp)}
        </ItemDescription>
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
            {m.domains_open()}
            <HugeiconsIcon icon={ArrowUpRight01Icon} />
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
          {removing && <Spinner />}
          {m.domains_unbind()}
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * 域名页:setIngress 改写 daemon 托管的 Caddy 配置并热重载,证书全权
 * 归 Caddy(ACME)。wire 是集合语义 — 增删都是"把想要的完整清单发过
 * 去",绑定弹窗在已绑清单上加一个、解绑在清单上减一个再整体提交。
 * 绑定失败不锁门::80 的 IP 访问在每次改写里都保留。
 */
export function DomainsPage() {
  const { data, isPending, isError, error } = useIngress();
  const mutation = useSetIngress();
  const [removing, setRemoving] = useState<string | null>(null);

  const statuses = data?.domains ?? [];
  const bound = statuses.map((entry) => entry.domain);
  const publicIp = detectPublicIp(statuses);

  const remove = (domain: string) => {
    setRemoving(domain);
    mutation.mutate(
      bound.filter((entry) => entry !== domain),
      {
        onSuccess: () => toast.success(m.domains_unbind_success({ domain })),
        onError: (mutationError) => toast.error(mutationError.message),
        onSettled: () => setRemoving(null),
      },
    );
  };

  return (
    // 内容是竖排的域名条目与指引 — 不是表格页,限宽 4xl 读起来舒服。
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-medium">{m.domains_page_title()}</h1>
        {data?.managed && statuses.length > 0 && (
          <BindDomainDialog bound={bound} publicIp={publicIp} />
        )}
      </header>

      {isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {m.domains_loading()}
        </div>
      ) : isError ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{m.domains_load_failed()}</EmptyTitle>
            <EmptyDescription>{error.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !data.managed ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Globe02Icon} />
            </EmptyMedia>
            <EmptyTitle>{m.domains_unmanaged_title()}</EmptyTitle>
            <EmptyDescription>
              {m.domains_unmanaged_description()}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : statuses.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Globe02Icon} />
            </EmptyMedia>
            <EmptyTitle>{m.domains_empty_title()}</EmptyTitle>
            <EmptyDescription>{m.domains_empty_description()}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <BindDomainDialog bound={bound} publicIp={publicIp} />
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <ItemGroup className="gap-2">
            {statuses.map((status) => (
              <DomainItem
                key={status.domain}
                status={status}
                publicIp={publicIp}
                removing={removing === status.domain}
                busy={mutation.isPending}
                onRemove={() => remove(status.domain)}
              />
            ))}
          </ItemGroup>
          <p className="text-sm text-muted-foreground">
            {m.domains_probe_footnote()}
          </p>
        </>
      )}
    </div>
  );
}
