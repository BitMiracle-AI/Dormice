import { Alert, AlertDescription } from '@/components/ui/alert';
import { pctOf } from '@/lib/format';
import { fullClock } from '../format';
import {
  TIMELINE_RANGES,
  type TimelineRangeKey,
  useFleetTimeline,
} from '../hooks/useFleetTimeline';
import { useHostMetrics } from '../hooks/useHostMetrics';
import { Meter } from './Meter';
import { Sparkline } from './Sparkline';
import { StatCard, StatCardSkeleton } from './StatCard';

/**
 * 舰队三卡:当前活跃(5 秒一刷的快照 + 窗口内活跃数 sparkline)、窗口
 * 峰值、总数/容量。当前值来自 /getHostMetrics;峰值与 sparkline 来自
 * /getFleetTimeline — daemon 采样器 30 秒落一行,峰值由原始行现算,
 * 分桶抹不掉它。档位由页头的全局切换器驱动。
 */
export function FleetStatCards({ range }: { range: TimelineRangeKey }) {
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
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {['active', 'peak', 'total'].map((slot) => (
          <StatCardSkeleton key={slot} />
        ))}
      </div>
    );
  }

  const { sandboxes } = host.data;
  const { points, peak } = timeline.data;
  const activeSeries = points.map((p) => p.byState.active);
  const capacityPct = Math.round(
    pctOf(sandboxes.total, sandboxes.maxSandboxes),
  );

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatCard
        label="当前活跃"
        value={String(sandboxes.byState.active)}
        hint="此刻正在运行的沙箱"
        sub="其余状态都不占 CPU"
        corner={
          <Sparkline
            data={activeSeries}
            className="w-20 shrink-0 @[250px]/card:w-24"
          />
        }
      />
      <StatCard
        label={`${rangeLabel}内峰值`}
        value={peak === null ? '—' : String(peak.active)}
        hint="活跃并发最高点"
        sub={
          peak === null
            ? '窗口内还没有采样'
            : `出现于 ${fullClock(Date.parse(peak.at))}`
        }
      />
      <StatCard
        label="沙箱总数"
        value={`${sandboxes.total} / ${sandboxes.maxSandboxes}`}
        hint={`容量上限 ${sandboxes.maxSandboxes}`}
        sub={`已用 ${capacityPct}%`}
        corner={
          <div className="w-20 shrink-0 pb-1.5 @[250px]/card:w-24">
            <Meter pct={capacityPct} />
          </div>
        }
        to="/sandboxes"
      />
    </div>
  );
}
