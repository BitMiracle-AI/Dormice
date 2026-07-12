import type { GetIngressResponse } from '@dormice/shared';
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useIngress, useSetIngress } from '../hooks/useIngress';

/**
 * 一行探测结果:绿 = 事实成立,黄 = 还没成立(等待中,不是故障),
 * 红 = 探测本身失败。probe 是 daemon 请求时现测的,不是缓存。
 */
function ProbeRow({
  label,
  ok,
  pendingText,
  okText,
  errorText,
}: {
  label: string;
  ok: boolean;
  pendingText: string;
  okText: string;
  errorText: string | null;
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? (
        <HugeiconsIcon
          icon={CheckmarkCircle01Icon}
          className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
        />
      ) : (
        <HugeiconsIcon
          icon={Alert02Icon}
          className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
      )}
      <div>
        <span className="font-medium">{label}</span>{' '}
        <span className="text-muted-foreground">
          {ok ? okText : pendingText}
        </span>
        {!ok && errorText && (
          <div className="font-mono text-xs text-muted-foreground">
            {errorText}
          </div>
        )}
      </div>
    </div>
  );
}

function DomainForm({
  initial,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: string;
  pending: boolean;
  onSubmit: (domain: string) => void;
  onCancel?: () => void;
}) {
  const [domain, setDomain] = useState(initial);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(domain.trim());
      }}
    >
      <Field>
        <FieldLabel htmlFor="ingress-domain">域名</FieldLabel>
        <Input
          id="ingress-domain"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          placeholder="console.example.com"
          className="font-mono"
        />
        <FieldDescription>
          先去域名商处添加一条 A 记录,指向本机的公网 IP;绑定后 Caddy 会自动向
          Let's Encrypt 申请并续期证书,无需手动配置。
        </FieldDescription>
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={domain.trim().length === 0 || pending}>
          {pending && <Spinner />}
          绑定
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
    </form>
  );
}

function BoundStatus({
  status,
  pending,
  onRebind,
  onClear,
}: {
  status: GetIngressResponse & { domain: string };
  pending: boolean;
  onRebind: (domain: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const probe = status.probe;
  const dnsOk = (probe?.dnsAddresses.length ?? 0) > 0 && !probe?.dnsError;
  const tlsOk = probe?.tlsOk ?? false;
  // 探测跑在 daemon 主机上,证明不了公网可达 — 安全组是它看不见的一层。
  const hereOverHttp = window.location.protocol === 'http:';

  if (editing) {
    return (
      <DomainForm
        initial={status.domain}
        pending={pending}
        onSubmit={onRebind}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="font-mono text-sm">{status.domain}</div>
      <div className="flex flex-col gap-2">
        <ProbeRow
          label="DNS 解析"
          ok={dnsOk}
          okText={`已解析到 ${probe?.dnsAddresses.join(', ')}`}
          pendingText={
            probe?.dnsError
              ? 'DNS 查询失败'
              : '还没有解析记录 — 去域名商处加 A 记录指向本机公网 IP,生效通常要几分钟'
          }
          errorText={probe?.dnsError ?? null}
        />
        <ProbeRow
          label="HTTPS 证书"
          ok={tlsOk}
          okText="证书已签发,HTTPS 正常服务"
          pendingText={
            dnsOk
              ? '签发中 — Caddy 会自动重试,通常一分钟内完成'
              : '等 DNS 生效后 Caddy 自动申请,无需操作'
          }
          errorText={tlsOk ? null : (probe?.tlsError ?? null)}
        />
        {tlsOk && hereOverHttp && (
          <p className="text-sm text-muted-foreground">
            当前页面还在用明文 HTTP — 若浏览器打不开下面的 HTTPS
            地址,通常是云安全组还没放行 443 端口。
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {tlsOk && hereOverHttp && (
          <Button
            nativeButton={false}
            // 整页跳转:换源意味着 cookie 换域,重新登录是预期行为。
            render={<a href={`https://${status.domain}/console/settings`} />}
          >
            改用 HTTPS 访问
            <HugeiconsIcon icon={ArrowUpRight01Icon} />
          </Button>
        )}
        <Button variant="outline" onClick={() => setEditing(true)}>
          更换域名
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onClear}>
          {pending && <Spinner />}
          解除绑定
        </Button>
      </div>
    </div>
  );
}

/**
 * 域名与 HTTPS:setIngress 改写 daemon 托管的 Caddy 配置并热重载,
 * 证书全权归 Caddy(ACME)。绑定失败不锁门 — :80 的 IP 访问始终保留。
 */
export function IngressCard() {
  const { data, isPending, isError, error } = useIngress();
  const mutation = useSetIngress();

  const submit = (domain: string | null) => {
    mutation.mutate(domain, {
      onSuccess: () =>
        toast.success(
          domain ? `已绑定 ${domain},等待证书签发` : '已解除绑定,回到 IP 访问',
        ),
      onError: (mutationError) => toast.error(mutationError.message),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>域名与 HTTPS</CardTitle>
        <CardDescription>
          给控制台(和 API)绑一个域名。证书自动申请与续期;绑定期间 IP
          访问始终可用,不会被锁在门外。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> 读取接入层状态…
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">{error.message}</p>
        ) : !data.managed ? (
          <p className="text-sm text-muted-foreground">
            本 daemon 未接管反向代理(DORMICE_INGRESS_FILE
            未配置),网页绑定不可用。重跑 install.sh 会自动装配 Caddy
            并打开这里;或继续自行维护你的代理配置。
          </p>
        ) : data.domain === null ? (
          <DomainForm
            initial=""
            pending={mutation.isPending}
            onSubmit={submit}
          />
        ) : (
          <BoundStatus
            status={data as GetIngressResponse & { domain: string }}
            pending={mutation.isPending}
            onRebind={submit}
            onClear={() => submit(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}
