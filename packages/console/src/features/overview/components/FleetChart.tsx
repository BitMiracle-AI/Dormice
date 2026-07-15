import type { GetFleetTimelineResponse, SandboxState } from '@dormice/shared';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  Card,
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
import { STATE_COLORS, STATE_LABELS } from '@/features/sandboxes/format';
import { cn } from '@/lib/utils';
import { fullClock, tickFormatter } from '../format';
import {
  type TimelineRangeKey,
  useFleetTimeline,
} from '../hooks/useFleetTimeline';

/**
 * 堆叠顺序:活跃垫底(它是主角,贴着基线最好读),往上依次是越来越冷
 * 的状态 — 面积图从下往上就是"从热到冷",与生命周期同向。
 *
 * 图形保持面积图不抄 openasi 的条形图:它画的是"每个桶发生了多少请求"
 * (流量),我们画的是"每一刻各状态有多少沙箱"(存量水位)— 水位就该
 * 用面积。
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

/**
 * 舰队并发走势卡:按状态堆叠的面积图,档位由页头的全局切换器驱动。
 * flex 布局把图撑满卡片剩余高度 — 页面把这张卡拉到与右侧宿主健康卡
 * 等高(3:1 网格),图有多高由卡说了算,不写死像素。
 */
export function FleetChart({
  range,
  className,
}: {
  range: TimelineRangeKey;
  className?: string;
}) {
  const timeline = useFleetTimeline(range);

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader>
        <CardTitle>沙箱并发走势</CardTitle>
        <CardDescription>
          各状态沙箱数量随时间的变化 — 活跃掉下去、冻结涨上来,就是
          「空闲即免费」在发生。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        <FleetChartBody range={range} timeline={timeline} />
      </CardContent>
    </Card>
  );
}

function FleetChartBody({
  range,
  timeline,
}: {
  range: TimelineRangeKey;
  timeline: ReturnType<typeof useFleetTimeline>;
}) {
  if (timeline.isError) {
    return (
      <div className="flex min-h-[260px] flex-1 items-center justify-center text-sm text-destructive">
        {timeline.error.message}
      </div>
    );
  }

  if (!timeline.data) {
    return <Skeleton className="min-h-[260px] w-full flex-1 rounded-xl" />;
  }

  const { points, bucketSeconds } = timeline.data;
  const rows = toChartRows(points, bucketSeconds);

  if (rows.length < 2) {
    return (
      <Empty className="min-h-[260px] flex-1 border border-dashed">
        <EmptyHeader>
          <EmptyTitle>窗口内还没有走势可画</EmptyTitle>
          <EmptyDescription>
            daemon 每 30 秒落一次采样,攒够两个点就开始画;daemon
            停机的时段没有采样,曲线会如实断开。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-full min-h-[260px] w-full flex-1"
    >
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
  );
}
