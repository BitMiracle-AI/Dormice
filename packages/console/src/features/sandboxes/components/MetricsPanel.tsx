import type { Sandbox } from '@dormice/shared';
import {
  CpuIcon,
  HardDriveIcon,
  RamMemoryIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import { SampleDataBadge } from '@/components/SampleDataBadge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { formatBytes, pctOf } from '@/lib/format';
import { MOCK_PAGES_ENABLED } from '@/lib/mock';
import { cn } from '@/lib/utils';

/**
 * 提案中的 wire 形状:原生 POST /getSandboxMetrics { userKey } 的响应。
 * 单次快照,与 getHostMetrics/E2B getMetrics 同一原则 — 观察窗不是监控
 * 系统;执行器的 metrics() 动词已经存在,服务端落地时这个类型进 shared。
 */
interface SandboxMetricsSample {
  timestamp: string;
  cpuCount: number;
  cpuUsedPct: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
}

const SAMPLE: SandboxMetricsSample = {
  timestamp: new Date().toISOString(),
  cpuCount: 2,
  cpuUsedPct: 23.4,
  memUsedBytes: 412 * 1024 * 1024,
  memTotalBytes: 2 * 1024 * 1024 * 1024,
  diskUsedBytes: 68.2 * 1024 * 1024,
  diskTotalBytes: 10 * 1024 * 1024 * 1024,
};

function Meter({ pct }: { pct: number }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const [fill, track] =
    clamped >= 90
      ? ['bg-red-500', 'bg-red-500/15']
      : clamped >= 75
        ? ['bg-amber-500', 'bg-amber-500/15']
        : ['bg-primary', 'bg-primary/10'];
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full', track)}>
      <div
        className={cn('h-full rounded-full', fill)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  hint,
  pct,
}: {
  icon: NonNullable<HugeiconsProps['icon']>;
  label: string;
  value: string;
  hint: string;
  pct: number;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <HugeiconsIcon icon={icon} className="size-4" strokeWidth={1.8} />
          {label}
        </div>
        <div className="text-2xl font-semibold">{value}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
        <Meter pct={pct} />
      </CardContent>
    </Card>
  );
}

/**
 * 单沙箱指标。控制台走 cookie,而 E2B 的 metrics 端点只认 API key,
 * 浏览器刻意拿不到 — 所以这一面要等原生 /getSandboxMetrics 动词落地,
 * 眼下先用示例数据把版式定下来(执行器侧 metrics() 已经存在,缺的只是
 * 一个原生路由)。
 */
export function MetricsPanel(_props: { sandbox: Sandbox }) {
  if (!MOCK_PAGES_ENABLED) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>尚未接入</EmptyTitle>
          <EmptyDescription>
            单沙箱指标等原生 getSandboxMetrics 动词落地后可用。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SampleDataBadge />
        <span className="text-sm text-muted-foreground">
          版式预览 — 接入原生 getSandboxMetrics 后换真数据(单次快照,
          观察不唤醒)。
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          icon={CpuIcon}
          label="CPU"
          value={`${Math.round(SAMPLE.cpuUsedPct)}%`}
          hint={`${SAMPLE.cpuCount} 核`}
          pct={SAMPLE.cpuUsedPct}
        />
        <MetricCard
          icon={RamMemoryIcon}
          label="内存"
          value={formatBytes(SAMPLE.memUsedBytes)}
          hint={`共 ${formatBytes(SAMPLE.memTotalBytes)}`}
          pct={pctOf(SAMPLE.memUsedBytes, SAMPLE.memTotalBytes)}
        />
        <MetricCard
          icon={HardDriveIcon}
          label="磁盘"
          value={formatBytes(SAMPLE.diskUsedBytes)}
          hint={`名义 ${formatBytes(SAMPLE.diskTotalBytes)} — 稀疏镜像只为真实内容付费`}
          pct={pctOf(SAMPLE.diskUsedBytes, SAMPLE.diskTotalBytes)}
        />
      </div>
    </div>
  );
}
