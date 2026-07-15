import type { GetFleetTimelineResponse, SandboxState } from '@dormice/shared';
import {
  Activity01Icon,
  ArrowUpRight01Icon,
  PackageIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { STATE_COLORS, STATE_LABELS } from '@/features/sandboxes/format';
import { pctOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  TIMELINE_RANGES,
  type TimelineRangeKey,
  useFleetTimeline,
} from '../hooks/useFleetTimeline';
import { useHostMetrics } from '../hooks/useHostMetrics';

/**
 * 堆叠顺序:活跃垫底(它是主角,贴着基线最好读),往上依次是越来越冷
 * 的状态 — 面积图从下往上就是"从热到冷",与生命周期同向。
 */
const STACK_ORDER: SandboxState[] = [
  'active',
  'frozen',
  'stopped',
  'archived',
  'restoring',
];

const chartConfig = Object.fromEntries(
  STACK_ORDER.map((state) => [
    state,
    { label: STATE_LABELS[state], theme: STATE_COLORS[state].chart },
  ]),
) satisfies ChartConfig;

type ChartRow = { at: number } & Record<SandboxState, number | null>;

/**
 * 时间线点 → 图表行,并在采样断档处插一行 null:daemon 停机的时段
 * 曲线要如实断开(connectNulls 关着),不许把空窗连成一条谎线。断档
 * 的判据是点距超过期望间距的 3 倍 — 期望间距优先用服务端的桶宽,原始
 * 样本则取中位点距(采样间隔是服务端配置,客户端不猜死值)。
 */
function toChartRows(
  points: GetFleetTimelineResponse['points'],
  bucketSeconds: number | null,
): ChartRow[] {
  const rows: ChartRow[] = points.map((p) => ({
    at: Date.parse(p.at),
    ...p.byState,
  }));
  const first = rows[0];
  if (rows.length < 2 || first === undefined) return rows;

  const deltas: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev !== undefined && cur !== undefined) deltas.push(cur.at - prev.at);
  }
  deltas.sort((a, b) => a - b);
  const expectedMs =
    bucketSeconds !== null
      ? bucketSeconds * 1000
      : (deltas[Math.floor(deltas.length / 2)] ?? 0);

  const withGaps: ChartRow[] = [first];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev === undefined || cur === undefined) continue;
    if (expectedMs > 0 && cur.at - prev.at > 3 * expectedMs) {
      withGaps.push({
        at: Math.round((prev.at + cur.at) / 2),
        active: null,
        frozen: null,
        stopped: null,
        archived: null,
        restoring: null,
      });
    }
    withGaps.push(cur);
  }
  return withGaps;
}

/** 长窗口给日期,短窗口给钟点 — 刻度只说这个窗口内有区分度的部分。 */
function tickFormatter(range: TimelineRangeKey): (ms: number) => string {
  if (range === '7d' || range === '30d') {
    return (ms) => {
      const d = new Date(ms);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    };
  }
  return (ms) =>
    new Date(ms).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
}

/** tooltip 与峰值注脚共用的完整时刻写法。 */
function fullClock(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    hour12: false,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatCard({
  icon,
  label,
  value,
  hint,
  to,
}: {
  icon: NonNullable<HugeiconsProps['icon']>;
  label: string;
  value: string;
  hint: string;
  to?: string;
}) {
  const card = (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <HugeiconsIcon icon={icon} className="size-4" strokeWidth={1.8} />
          {label}
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
  if (!to) return card;
  return (
    <Link
      to={to}
      className="block rounded-[min(var(--radius-4xl),24px)] transition-shadow hover:ring-2 hover:ring-primary/30"
    >
      {card}
    </Link>
  );
}

/**
 * 舰队并发一览:三张统计卡(当前活跃 5 秒一刷、窗口峰值与总数)加一张
 * 按状态堆叠的走势图。当前值来自 /getHostMetrics 快照;历史与峰值来自
 * /getFleetTimeline — daemon 的采样器 30 秒落一行,窗口峰值由原始行现算,
 * 分桶抹不掉它。
 */
export function FleetOverview() {
  const [range, setRange] = useState<TimelineRangeKey>('24h');
  const host = useHostMetrics();
  const timeline = useFleetTimeline(range);
  const rangeLabel =
    TIMELINE_RANGES.find((r) => r.key === range)?.label ?? range;

  if (host.isError || timeline.isError) {
    const message = host.isError
      ? host.error.message
      : (timeline.error?.message ?? '');
    return (
      <Alert variant="destructive">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    );
  }

  if (!host.data || !timeline.data) {
    // 骨架镜像真实结构:三张统计卡 + 一张图表卡,高度与加载完成后一致。
    return (
      <section className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {['active', 'peak', 'total'].map((slot) => (
            <Card key={slot} size="sm">
              <CardContent className="flex flex-col gap-2">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-4 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[280px] w-full" />
          </CardContent>
        </Card>
      </section>
    );
  }

  const { sandboxes } = host.data;
  const { points, bucketSeconds, peak } = timeline.data;
  const rows = toChartRows(points, bucketSeconds);

  return (
    <section className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={Activity01Icon}
          label="当前活跃"
          value={String(sandboxes.byState.active)}
          hint="此刻正在运行的沙箱 — 其余状态都不占 CPU"
        />
        <StatCard
          icon={ArrowUpRight01Icon}
          label={`${rangeLabel}内峰值`}
          value={peak === null ? '—' : String(peak.active)}
          hint={
            peak === null
              ? '窗口内还没有采样'
              : `活跃并发最高点,出现于 ${fullClock(Date.parse(peak.at))}`
          }
        />
        <StatCard
          icon={PackageIcon}
          label="沙箱总数"
          value={`${sandboxes.total} / ${sandboxes.maxSandboxes}`}
          hint={`容量上限 ${sandboxes.maxSandboxes},已用 ${Math.round(pctOf(sandboxes.total, sandboxes.maxSandboxes))}%`}
          to="/sandboxes"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>沙箱并发走势</CardTitle>
          <CardDescription>
            各状态沙箱数量随时间的变化 — 活跃掉下去、冻结涨上来,就是
            「空闲即免费」在发生。
          </CardDescription>
          <CardAction>
            <ToggleGroup
              value={[range]}
              onValueChange={(value: unknown[]) => {
                // base-ui 允许再点一下取消选中(空数组)— 档位必须常有,忽略。
                const next = value[0];
                if (typeof next === 'string') {
                  setRange(next as TimelineRangeKey);
                }
              }}
              variant="outline"
              size="sm"
            >
              {TIMELINE_RANGES.map((r) => (
                <ToggleGroupItem key={r.key} value={r.key}>
                  {r.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </CardAction>
        </CardHeader>
        <CardContent>
          {rows.length < 2 ? (
            <Empty className={cn('border border-dashed', 'h-[280px]')}>
              <EmptyHeader>
                <EmptyTitle>窗口内还没有走势可画</EmptyTitle>
                <EmptyDescription>
                  daemon 每 30 秒落一次采样,攒够两个点就开始画;daemon
                  停机的时段没有采样,曲线会如实断开。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ChartContainer config={chartConfig} className="h-[280px] w-full">
              <AreaChart data={rows} margin={{ left: 4, right: 12, top: 4 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="at"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={tickFormatter(range)}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={48}
                />
                <YAxis
                  width={36}
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  tickCount={4}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(_, payload) =>
                        fullClock((payload?.[0]?.payload as { at: number }).at)
                      }
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {STACK_ORDER.map((state) => (
                  <Area
                    key={state}
                    dataKey={state}
                    stackId="fleet"
                    type="monotone"
                    stroke={`var(--color-${state})`}
                    fill={`var(--color-${state})`}
                    fillOpacity={0.35}
                    strokeWidth={2}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                ))}
              </AreaChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
