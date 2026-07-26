import type { Sandbox, SandboxMetricsSample } from '@dormice/shared';
import {
  CpuIcon,
  HardDriveIcon,
  RamMemoryIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import { useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Meter } from '@/components/Meter';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { withGapBreaks } from '@/lib/chart-gaps';
import { formatBytes, pctOf } from '@/lib/format';
import { m } from '@/paraglide/messages';
import { getLocale } from '@/paraglide/runtime';
import { ago } from '../format';
import {
  useSandboxMetrics,
  useSandboxMetricsHistory,
} from '../hooks/useSandboxes';

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

/** 历史档位 — daemon 留 7 天逐沙箱样本,档位到 7 天为止。 */
const HISTORY_RANGES = [
  { key: '1h', spanMs: 3600_000 },
  { key: '24h', spanMs: 24 * 3600_000 },
  { key: '7d', spanMs: 7 * 86_400_000 },
] as const;

type HistoryRangeKey = (typeof HISTORY_RANGES)[number]['key'];

function rangeLabel(key: HistoryRangeKey): string {
  switch (key) {
    case '1h':
      return m.sandboxes_range_1h();
    case '24h':
      return m.sandboxes_range_24h();
    case '7d':
      return m.sandboxes_range_7d();
  }
}

/** 短窗口给钟点,7 天窗口给日期 — 刻度只说窗口内有区分度的部分。 */
function clockFor(range: HistoryRangeKey): (ms: number) => string {
  if (range === '7d') {
    return (ms) => {
      const d = new Date(ms);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    };
  }
  return (ms) =>
    new Date(ms).toLocaleTimeString(getLocale(), {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
}

/** tooltip 用的完整时刻。 */
const fullClock = (ms: number) =>
  new Date(ms).toLocaleString(getLocale(), {
    hour12: false,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

type SeriesPoint = { at: number; value: number | null };

/**
 * 样本 → 单序列;断档处由 withGapBreaks 插一个 null 点,沙箱停着或
 * daemon 停机的时段曲线如实断开(connectNulls 关着)。
 */
function toSeries(
  samples: SandboxMetricsSample[],
  pick: (s: SandboxMetricsSample) => number,
  bucketSeconds: number | null,
): SeriesPoint[] {
  const points: SeriesPoint[] = samples.map((s) => ({
    at: Date.parse(s.timestamp),
    value: pick(s),
  }));
  return withGapBreaks(
    points,
    bucketSeconds,
    (p) => p.at,
    (at) => ({ at, value: null }),
  );
}

/**
 * 一个度量一张小图,单系列单轴(不同量纲绝不共轴)。线色用主题的
 * chart-2(已过明暗两面的对比度验证),身份由标题承担 — 单系列不需要
 * 图例。
 */
function HistoryChart({
  title,
  data,
  xTickFormatter,
  tickFormatter,
  valueFormatter,
  domainMax,
}: {
  title: string;
  data: SeriesPoint[];
  xTickFormatter: (ms: number) => string;
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
              tickFormatter={xTickFormatter}
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
                    fullClock((payload?.[0]?.payload as { at: number }).at)
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
              connectNulls={false}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/**
 * 单沙箱指标:上半是 5 秒一拍的当前值(观察不唤醒 — 冻结的沙箱睡着
 * 也能读,停了的沙箱没有容器可测,daemon 答 null,这里出空态而不是把
 * 它吵醒);下半是 daemon 采样器落库的历史(30 秒一刷)。两半各自处理
 * 空态:沙箱停着时当前值区出空态,历史照常在 — 历史是历史。
 */
export function MetricsPanel({ sandbox }: { sandbox: Sandbox }) {
  const [range, setRange] = useState<HistoryRangeKey>('1h');
  const live = useSandboxMetrics(sandbox.name);
  const spanMs =
    HISTORY_RANGES.find((r) => r.key === range)?.spanMs ?? 3600_000;
  const history = useSandboxMetricsHistory(sandbox.name, spanMs);

  if (live.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {m.sandboxes_loading_metrics()}
      </div>
    );
  }
  if (live.isError) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>{m.sandboxes_metrics_error_title()}</EmptyTitle>
          <EmptyDescription>{live.error.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const sample = live.data.sample;
  const samples = history.data?.samples ?? [];
  const bucketSeconds = history.data?.bucketSeconds ?? null;
  const lastSample = samples.at(-1) ?? sample;

  return (
    <div className="flex flex-col gap-3">
      {sample === null ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{m.sandboxes_no_container_title()}</EmptyTitle>
            <EmptyDescription>
              {m.sandboxes_no_container_desc()}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <MetricCard
            icon={CpuIcon}
            label="CPU"
            value={`${Math.round(sample.cpuUsedPct)}%`}
            hint={m.sandboxes_cpu_hint({ n: sample.cpuCount })}
            pct={sample.cpuUsedPct / sample.cpuCount}
          />
          <MetricCard
            icon={RamMemoryIcon}
            label={m.sandboxes_metric_memory()}
            value={formatBytes(sample.memUsedBytes)}
            hint={m.sandboxes_mem_hint({
              total: formatBytes(sample.memTotalBytes),
              cache: formatBytes(sample.memCacheBytes),
            })}
            pct={pctOf(sample.memUsedBytes, sample.memTotalBytes)}
          />
          <MetricCard
            icon={HardDriveIcon}
            label={m.sandboxes_metric_disk()}
            value={formatBytes(sample.diskUsedBytes)}
            hint={m.sandboxes_disk_hint({
              total: formatBytes(sample.diskTotalBytes),
            })}
            pct={pctOf(sample.diskUsedBytes, sample.diskTotalBytes)}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">{m.sandboxes_history_title()}</div>
        <ToggleGroup
          value={[range]}
          onValueChange={(value: unknown[]) => {
            // base-ui 允许再点一下取消选中(空数组)— 档位必须常有,忽略。
            const next = value[0];
            if (typeof next === 'string') setRange(next as HistoryRangeKey);
          }}
          variant="outline"
          size="sm"
        >
          {HISTORY_RANGES.map((r) => (
            <ToggleGroupItem key={r.key} value={r.key}>
              {rangeLabel(r.key)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {history.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{history.error.message}</AlertDescription>
        </Alert>
      ) : history.isPending ? (
        // 历史还在路上时不许说"没有走势"— 空态是断言,loading 不是。
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {m.sandboxes_loading_history()}
        </div>
      ) : samples.length < 2 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{m.sandboxes_no_history_title()}</EmptyTitle>
            <EmptyDescription>{m.sandboxes_no_history_desc()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          <HistoryChart
            title={m.sandboxes_chart_cpu()}
            data={toSeries(
              samples,
              (s) => Math.round(s.cpuUsedPct),
              bucketSeconds,
            )}
            xTickFormatter={clockFor(range)}
            tickFormatter={(v) => `${v}%`}
            valueFormatter={(v) => m.sandboxes_cpu_value({ v })}
          />
          <HistoryChart
            title={m.sandboxes_chart_memory()}
            data={toSeries(samples, (s) => s.memUsedBytes, bucketSeconds)}
            xTickFormatter={clockFor(range)}
            tickFormatter={(v) => formatBytes(v)}
            valueFormatter={(v) => formatBytes(v)}
            domainMax={lastSample?.memTotalBytes}
          />
          <HistoryChart
            title={m.sandboxes_chart_disk()}
            data={toSeries(samples, (s) => s.diskUsedBytes, bucketSeconds)}
            xTickFormatter={clockFor(range)}
            tickFormatter={(v) => formatBytes(v)}
            valueFormatter={(v) => formatBytes(v)}
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {sample !== null &&
          m.sandboxes_footer_live({ ago: ago(sample.timestamp) })}
        {m.sandboxes_footer_history()}
        {bucketSeconds !== null &&
          m.sandboxes_footer_bucketed({ n: Math.round(bucketSeconds / 60) })}
      </p>
    </div>
  );
}
