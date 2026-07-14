import type { Sandbox, SandboxMetricsSample } from '@dormice/shared';
import {
  CpuIcon,
  HardDriveIcon,
  RamMemoryIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { formatBytes, pctOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { since } from '../format';
import { useSandboxMetrics } from '../hooks/useSandboxes';

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

/** 滚动窗口容量:5 秒一拍 × 120 点 ≈ 最近 10 分钟。 */
const HISTORY_CAP = 120;

/**
 * 面板打开期间的采样累积。daemon 刻意不存指标历史(观察窗不是监控
 * 系统),但"刚才那一下是不是内存尖峰"值得回答 — 历史就攒在浏览器里,
 * 换沙箱清零,关面板即忘。
 */
function useSampleHistory(
  sandboxId: string,
  latest: SandboxMetricsSample | null | undefined,
): SandboxMetricsSample[] {
  const [history, setHistory] = useState<SandboxMetricsSample[]>([]);
  // 换沙箱清零:render 期重置(React 官方推荐形),不多跑一轮 effect。
  const [prevId, setPrevId] = useState(sandboxId);
  if (prevId !== sandboxId) {
    setPrevId(sandboxId);
    setHistory([]);
  }
  useEffect(() => {
    if (!latest) return;
    setHistory((prev) =>
      prev.at(-1)?.timestamp === latest.timestamp
        ? prev
        : [...prev.slice(-(HISTORY_CAP - 1)), latest],
    );
  }, [latest]);
  return history;
}

/** 时间轴刻度:HH:MM:SS,窗口只有分钟级,日期是噪声。 */
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

/**
 * 一个度量一张小图,单系列单轴(不同量纲绝不共轴)。线色用主题的
 * chart-2(已过明暗两面的对比度验证),身份由标题承担 — 单系列不需要
 * 图例。
 */
function HistoryChart({
  title,
  data,
  tickFormatter,
  valueFormatter,
  domainMax,
}: {
  title: string;
  data: Array<{ at: number; value: number }>;
  tickFormatter: (value: number) => string;
  valueFormatter: (value: number) => string;
  domainMax?: number;
}) {
  const config = {
    value: { label: title, color: 'var(--chart-2)' },
  } satisfies ChartConfig;
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="text-sm text-muted-foreground">{title}</div>
        <ChartContainer config={config} className="aspect-[2/1] w-full">
          <LineChart data={data} margin={{ left: 4, right: 12, top: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="at"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={clock}
              tickLine={false}
              axisLine={false}
              minTickGap={48}
            />
            <YAxis
              width={44}
              domain={[0, domainMax ?? 'auto']}
              tickFormatter={tickFormatter}
              tickLine={false}
              axisLine={false}
              tickCount={3}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    clock((payload?.[0]?.payload as { at: number }).at)
                  }
                  formatter={(value) => valueFormatter(Number(value))}
                />
              }
            />
            <Line
              dataKey="value"
              type="monotone"
              stroke="var(--color-value)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/**
 * 单沙箱指标:5 秒一拍的单次快照(观察窗不是监控系统)。观察不唤醒 —
 * 冻结的沙箱睡着也能读(cgroup 记账还在),停了的沙箱没有容器可测,
 * daemon 答 null,这里出空态而不是把它吵醒。
 */
export function MetricsPanel({ sandbox }: { sandbox: Sandbox }) {
  const { data, isPending, isError, error } = useSandboxMetrics(
    sandbox.externalId,
  );
  // Hook 在任何 early return 之前:面板打开期间持续累积,换沙箱清零。
  const history = useSampleHistory(sandbox.sandboxId, data?.sample);

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> 读取指标
      </div>
    );
  }
  if (isError) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>读取失败</EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const sample = data.sample;
  if (sample === null) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>没有运行中的容器可测</EmptyTitle>
          <EmptyDescription>
            沙箱现在没有活着的容器(已停止/已归档)。观察不唤醒 —
            打开终端或执行命令才会把它叫醒。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          icon={CpuIcon}
          label="CPU"
          value={`${Math.round(sample.cpuUsedPct)}%`}
          hint={`${sample.cpuCount} 核 · 百分比按单核计`}
          pct={sample.cpuUsedPct / sample.cpuCount}
        />
        <MetricCard
          icon={RamMemoryIcon}
          label="内存"
          value={formatBytes(sample.memUsedBytes)}
          hint={`共 ${formatBytes(sample.memTotalBytes)} · 缓存 ${formatBytes(sample.memCacheBytes)}`}
          pct={pctOf(sample.memUsedBytes, sample.memTotalBytes)}
        />
        <MetricCard
          icon={HardDriveIcon}
          label="磁盘"
          value={formatBytes(sample.diskUsedBytes)}
          hint={`名义 ${formatBytes(sample.diskTotalBytes)} — 稀疏镜像只为真实内容付费`}
          pct={pctOf(sample.diskUsedBytes, sample.diskTotalBytes)}
        />
      </div>
      {history.length >= 2 && (
        <div className="grid gap-4 xl:grid-cols-3">
          <HistoryChart
            title="CPU 走势"
            data={history.map((s) => ({
              at: Date.parse(s.timestamp),
              value: Math.round(s.cpuUsedPct),
            }))}
            tickFormatter={(v) => `${v}%`}
            valueFormatter={(v) => `${v}%(按单核计)`}
          />
          <HistoryChart
            title="内存走势"
            data={history.map((s) => ({
              at: Date.parse(s.timestamp),
              value: s.memUsedBytes,
            }))}
            tickFormatter={(v) => formatBytes(v)}
            valueFormatter={(v) => formatBytes(v)}
            domainMax={sample.memTotalBytes}
          />
          <HistoryChart
            title="磁盘走势"
            data={history.map((s) => ({
              at: Date.parse(s.timestamp),
              value: s.diskUsedBytes,
            }))}
            tickFormatter={(v) => formatBytes(v)}
            valueFormatter={(v) => formatBytes(v)}
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        单次快照,5 秒刷新;本次读数取自 {since(sample.timestamp)}前。
        {history.length >= 2 &&
          `走势为本面板打开以来的采样(最多约 ${Math.round((HISTORY_CAP * 5) / 60)} 分钟),daemon 不存历史。`}
      </p>
    </div>
  );
}
