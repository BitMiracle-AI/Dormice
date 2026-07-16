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
    'dns-mismatch': {
      label: '解析指向了别处',
      className:
        'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
    },
    'dns-error': {
      label: 'DNS 查询失败',
      className:
        'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
    },
  };

function describeProbe(
  probe: IngressProbe,
  phase: DomainPhase,
  publicIp: string | null,
): string {
  const resolved = `已解析到 ${probe.dnsAddresses.join(', ')}`;
  switch (phase) {
    case 'ready':
      return `${resolved};证书已签发,HTTPS 正常服务`;
    case 'issuing':
      return `${resolved};Caddy 正在申请证书 — 自动重试,通常一分钟内完成`;
    case 'waiting-dns':
      return '还没有解析记录 — 按绑定弹窗里的指引加一条 A 记录,生效通常要几分钟';
    case 'dns-mismatch':
      return `解析到 ${probe.dnsAddresses.join(', ')},但本机是 ${publicIp} — 去域名商处把 A 记录的记录值改成本机 IP`;
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
            {badge.label}
          </Badge>
          {isHere && <Badge variant="secondary">当前访问</Badge>}
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
        onSuccess: () => toast.success(`已解绑 ${domain}`),
        onError: (mutationError) => toast.error(mutationError.message),
        onSettled: () => setRemoving(null),
      },
    );
  };

  return (
    // 内容是竖排的域名条目与指引 — 不是表格页,限宽 4xl 读起来舒服。
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-medium">域名</h1>
        {data?.managed && statuses.length > 0 && (
          <BindDomainDialog bound={bound} publicIp={publicIp} />
        )}
      </header>

      {isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> 读取域名配置
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
      ) : statuses.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Globe02Icon} />
            </EmptyMedia>
            <EmptyTitle>还没有绑定域名</EmptyTitle>
            <EmptyDescription>
              绑定后 HTTPS 证书自动申请与续期;无论绑定成败,IP
              访问始终保留,不会被锁在门外。
            </EmptyDescription>
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
            以上探测跑在服务器本机,证明不了公网可达:若浏览器打不开 HTTPS
            地址,通常是云安全组还没放行 443 端口;中国大陆机房还需域名有 ICP
            备案,否则云厂商会在入口拦截(与本机配置无关)。
          </p>
        </>
      )}
    </div>
  );
}
