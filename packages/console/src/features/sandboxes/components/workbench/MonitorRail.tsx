import type { Sandbox } from '@dormice/shared';
import {
  ChartLineData01Icon,
  Copy01Icon,
  CpuIcon,
  HardDriveIcon,
  MoreVerticalIcon,
  RamMemoryIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { Meter } from '@/components/Meter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { actorLabel } from '@/features/activity/actors';
import { useActivity } from '@/features/activity/hooks/useActivity';
import {
  ACTIVITY_KIND_STYLES,
  activityKindLabel,
} from '@/features/activity/kinds';
import { useApiKeys } from '@/features/api-keys/hooks/useApiKeys';
import { Sparkline } from '@/features/overview/components/Sparkline';
import { copyText } from '@/lib/copy';
import { formatDateTime } from '@/lib/datetime';
import { formatBytes, pctOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages';
import { ago, policyLine } from '../../format';
import { useEnvdAuth, useKillProcess, useProcesses } from '../../hooks/useEnvd';
import {
  useSandboxImages,
  useSandboxMetrics,
  useSandboxMetricsHistory,
} from '../../hooks/useSandboxes';
import { LifecycleCountdown } from '../LifecycleCountdown';
import { MetricsPanel } from '../MetricsPanel';
import { SandboxStateBadge } from '../SandboxStateBadge';
import { UpgradableBadge } from '../UpgradableBadge';

/**
 * 工作台右栏:一眼看全这台"机器"的仪表 — 生命周期、资源水位、进程、
 * 最近活动、身份信息,全部常驻不进 tab。栏里全是只读观察(指标不 wake、
 * Process/List 服务端刻意不唤醒、活动读 daemon 账本),挂着不违反
 * "看不解冻"纪律;唯一的写动作 kill 站在显式点击后面。
 */

function RailCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm" className="shrink-0">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{title}</span>
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function LifecycleCard({ sandbox }: { sandbox: Sandbox }) {
  return (
    <RailCard
      title={m.workbench_lifecycle()}
      action={<SandboxStateBadge state={sandbox.state} />}
    >
      <LifecycleCountdown sandbox={sandbox} />
      <div className="text-xs text-muted-foreground">
        {policyLine(sandbox.policy)}
      </div>
    </RailCard>
  );
}

function VitalCard({
  icon,
  label,
  value,
  hint,
  pct,
  spark,
}: {
  icon: NonNullable<HugeiconsProps['icon']>;
  label: string;
  value: string;
  hint: string;
  pct: number | null;
  spark: number[];
}) {
  return (
    <Card size="sm" className="shrink-0">
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <HugeiconsIcon icon={icon} className="size-4" strokeWidth={1.8} />
            {label}
          </span>
          <span className="text-sm font-semibold tabular-nums">{value}</span>
        </div>
        {spark.length >= 2 && <Sparkline data={spark} className="h-8 w-full" />}
        <Meter pct={pct} />
        <div className="text-xs text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}

function VitalsSection({ sandbox }: { sandbox: Sandbox }) {
  const [chartsOpen, setChartsOpen] = useState(false);
  const live = useSandboxMetrics(sandbox.name);
  // 1 小时窗口喂 sparkline — 右栏只答"最近的形状",完整走势在弹窗。
  const history = useSandboxMetricsHistory(sandbox.name, 3600_000);
  const sample = live.data?.sample ?? null;
  const samples = history.data?.samples ?? [];
  // 停机沙箱当前值为 null(观察不唤醒,没有容器可测),出诚实空值;
  // 历史照画 — 历史是历史。
  const offlineHint = m.workbench_offline_hint();

  return (
    <>
      <div className="flex shrink-0 items-center justify-between">
        <span className="text-sm font-medium">{m.workbench_resources()}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground"
          onClick={() => setChartsOpen(true)}
        >
          <HugeiconsIcon icon={ChartLineData01Icon} className="size-3.5" />
          {m.workbench_full_charts()}
        </Button>
      </div>
      <VitalCard
        icon={CpuIcon}
        label="CPU"
        value={sample ? `${Math.round(sample.cpuUsedPct)}%` : '—'}
        hint={
          sample
            ? m.workbench_cpu_hint({ count: sample.cpuCount })
            : offlineHint
        }
        pct={sample ? sample.cpuUsedPct / sample.cpuCount : null}
        spark={samples.map((s) => s.cpuUsedPct)}
      />
      <VitalCard
        icon={RamMemoryIcon}
        label={m.workbench_memory()}
        value={sample ? formatBytes(sample.memUsedBytes) : '—'}
        hint={
          sample
            ? m.workbench_mem_hint({ total: formatBytes(sample.memTotalBytes) })
            : offlineHint
        }
        pct={sample ? pctOf(sample.memUsedBytes, sample.memTotalBytes) : null}
        spark={samples.map((s) => s.memUsedBytes)}
      />
      <VitalCard
        icon={HardDriveIcon}
        label={m.workbench_disk()}
        value={sample ? formatBytes(sample.diskUsedBytes) : '—'}
        hint={
          sample
            ? m.workbench_disk_hint({
                total: formatBytes(sample.diskTotalBytes),
              })
            : offlineHint
        }
        pct={sample ? pctOf(sample.diskUsedBytes, sample.diskTotalBytes) : null}
        spark={samples.map((s) => s.diskUsedBytes)}
      />
      <Dialog open={chartsOpen} onOpenChange={setChartsOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {m.workbench_metrics_title({ name: sandbox.name })}
            </DialogTitle>
            <DialogDescription>{m.workbench_metrics_desc()}</DialogDescription>
          </DialogHeader>
          <MetricsPanel sandbox={sandbox} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProcessesCard({ sandbox }: { sandbox: Sandbox }) {
  // 只有物理容器在(active/frozen)才有进程表;停机沙箱只剩磁盘。
  const hasContainer = sandbox.state === 'active' || sandbox.state === 'frozen';
  const auth = useEnvdAuth(sandbox.id);
  const processes = useProcesses(auth.data, hasContainer);
  const kill = useKillProcess(auth.data);
  const list = processes.data ?? [];

  // kill 在服务端走 wakeForUse(发信号=用沙箱,会唤醒 frozen)——它站在
  // 两次显式点击(⋯ → 信号)后面,合规。
  const sendSignal = (
    pid: number,
    signal: 'SIGNAL_SIGTERM' | 'SIGNAL_SIGKILL',
  ) => {
    kill.mutate(
      { pid, signal },
      {
        onSuccess: () =>
          toast.success(
            m.workbench_signal_sent({
              pid,
              signal: signal === 'SIGNAL_SIGKILL' ? 'SIGKILL' : 'SIGTERM',
            }),
          ),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <RailCard
      title={m.workbench_processes()}
      action={
        hasContainer && list.length > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {list.length}
          </span>
        ) : undefined
      }
    >
      {!hasContainer ? (
        <p className="text-xs text-muted-foreground">
          {m.workbench_processes_asleep()}
        </p>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {m.workbench_processes_empty()}
        </p>
      ) : (
        <div className="flex flex-col">
          {list.map((process) => {
            const command = [process.config.cmd, ...process.config.args].join(
              ' ',
            );
            return (
              <div
                key={process.pid}
                className="group flex items-center gap-2 border-b py-1 text-xs last:border-b-0"
              >
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {process.pid}
                </span>
                <span
                  className="min-w-0 flex-1 truncate font-mono"
                  title={command}
                >
                  {command}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={m.workbench_process_actions({
                          pid: process.pid,
                        })}
                        className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                      >
                        <HugeiconsIcon icon={MoreVerticalIcon} />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => sendSignal(process.pid, 'SIGNAL_SIGTERM')}
                    >
                      {m.workbench_send_sigterm()}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => sendSignal(process.pid, 'SIGNAL_SIGKILL')}
                    >
                      {m.workbench_send_sigkill()}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      )}
    </RailCard>
  );
}

/** 右栏活动卡列几条最近的;全量(带筛选与详情列)在活动页。 */
const ACTIVITY_ROWS = 8;

function ActivityCard({ sandbox }: { sandbox: Sandbox }) {
  const { data } = useActivity(1000);
  const apiKeys = useApiKeys().data?.apiKeys;
  const events = (data?.events ?? []).filter(
    (event) => event.sandboxName === sandbox.name,
  );

  return (
    <RailCard
      title={m.workbench_recent_activity()}
      action={
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground"
          nativeButton={false}
          render={<Link to="/activity" search={{ sandbox: sandbox.name }} />}
        >
          {m.workbench_view_all()}
        </Button>
      }
    >
      {events.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {m.workbench_activity_empty()}
        </p>
      ) : (
        <div className="flex flex-col">
          {events.slice(0, ACTIVITY_ROWS).map((event) => (
            <div
              key={event.id}
              className="flex items-center gap-2 border-b py-1.5 text-xs last:border-b-0"
              title={`${formatDateTime(event.at)}${event.detail ? ` · ${event.detail}` : ''}`}
            >
              <Badge
                variant="outline"
                className={cn(
                  'shrink-0 font-medium',
                  ACTIVITY_KIND_STYLES[event.kind],
                )}
              >
                {activityKindLabel(event.kind)}
              </Badge>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  event.actor === null && 'text-muted-foreground',
                )}
              >
                {actorLabel(event.actor, apiKeys)}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {ago(event.at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </RailCard>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 text-xs last:border-b-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono">{children}</dd>
    </div>
  );
}

function InfoCard({ sandbox }: { sandbox: Sandbox }) {
  // 镜像血统与列表页同一份 5 秒缓存;拿不到就不显示,不挡卡片。
  const images = useSandboxImages();
  const lineage = images.data?.images.find(
    (entry) => entry.sandboxName === sandbox.name,
  );

  return (
    <RailCard
      title={m.workbench_sandbox_info()}
      action={
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6"
          aria-label={m.workbench_copy_id()}
          onClick={() =>
            copyText(sandbox.id).then(
              () => toast.success(m.workbench_copied_id()),
              () => toast.error(m.common_copy_failed()),
            )
          }
        >
          <HugeiconsIcon icon={Copy01Icon} />
        </Button>
      }
    >
      <dl>
        <InfoRow label="ID">
          <span title={sandbox.id}>{sandbox.id}</span>
        </InfoRow>
        <InfoRow label={m.workbench_template()}>
          <span className="inline-flex items-center gap-1.5">
            {sandbox.template ?? m.workbench_base_image()}
            <UpgradableBadge lineage={lineage} />
          </span>
        </InfoRow>
        {lineage && (
          <InfoRow label={m.workbench_image()}>
            {lineage.image === null
              ? m.workbench_image_next({ image: lineage.nextImage })
              : lineage.upgradable
                ? m.workbench_image_upgradable({
                    image: lineage.image,
                    next: lineage.nextImage,
                  })
                : lineage.image}
          </InfoRow>
        )}
        {Object.keys(sandbox.metadata).length > 0 && (
          <InfoRow label={m.workbench_labels()}>
            <span className="inline-flex flex-wrap justify-end gap-1">
              {Object.entries(sandbox.metadata).map(([key, value]) => (
                <Badge
                  key={key}
                  variant="outline"
                  className="max-w-[10rem] truncate font-mono text-xs font-normal text-muted-foreground"
                  title={`${key}=${value}`}
                >
                  {key}={value}
                </Badge>
              ))}
            </span>
          </InfoRow>
        )}
        <InfoRow label={m.workbench_node()}>{sandbox.nodeId}</InfoRow>
        <InfoRow label={m.workbench_endpoint()}>
          <span title={sandbox.endpoint}>{sandbox.endpoint}</span>
        </InfoRow>
        <InfoRow label={m.workbench_created_at()}>
          <span title={formatDateTime(sandbox.createdAt)}>
            {ago(sandbox.createdAt)}
          </span>
        </InfoRow>
        <InfoRow label={m.workbench_last_active()}>
          {ago(sandbox.lastActiveAt)}
        </InfoRow>
      </dl>
    </RailCard>
  );
}

export function MonitorRail({ sandbox }: { sandbox: Sandbox }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-background/40 p-3">
      <LifecycleCard sandbox={sandbox} />
      <VitalsSection sandbox={sandbox} />
      <ProcessesCard sandbox={sandbox} />
      <ActivityCard sandbox={sandbox} />
      <InfoCard sandbox={sandbox} />
    </div>
  );
}
