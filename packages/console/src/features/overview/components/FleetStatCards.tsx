import { Meter } from '@/components/Meter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { pctOf } from '@/lib/format';
import { m } from '@/paraglide/messages';
import { fullClock } from '../format';
import {
  TIMELINE_RANGES,
  type TimelineRangeKey,
  useFleetTimeline,
} from '../hooks/useFleetTimeline';
import { useHostMetrics } from '../hooks/useHostMetrics';
import { SandboxDisksCard } from './SandboxDisksCard';
import { Sparkline } from './Sparkline';
import { StatCard, StatCardSkeleton } from './StatCard';

/**
 * 舰队四卡(openasi 顶排版式,2026-07-16 沙箱磁盘上顶):当前活跃
 * (5 秒一刷的快照 + 窗口内活跃数 sparkline)、窗口峰值、总数/容量、
 * 沙箱磁盘账单。当前值来自 /getHostMetrics;峰值与 sparkline 来自
 * /getFleetTimeline — daemon 采样器 30 秒落一行,峰值由原始行现算,
 * 分桶抹不掉它。档位由页头的全局切换器驱动。
 */
export function FleetStatCards({ range }: { range: TimelineRangeKey }) {
  const host = useHostMetrics();
  const timeline = useFleetTimeline(range);
  const rangeLabel =
    TIMELINE_RANGES.find((r) => r.key === range)?.label() ?? range;

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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {['active', 'peak', 'total', 'disks'].map((slot) => (
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
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label={m.overview_stat_active_label()}
        // 四列布局下 footer 左栏只有 8 个汉字宽,文案按这个上限写。
        value={String(sandboxes.byState.active)}
        hint={m.overview_stat_active_hint()}
        sub={m.overview_stat_active_sub()}
        corner={
          <Sparkline
            data={activeSeries}
            className="w-20 shrink-0 @[250px]/card:w-24"
          />
        }
      />
      <StatCard
        label={m.overview_stat_peak_label({ range: rangeLabel })}
        value={peak === null ? '—' : String(peak.active)}
        hint={m.overview_stat_peak_hint()}
        sub={
          peak === null
            ? m.overview_stat_peak_none()
            : m.overview_stat_peak_at({ time: fullClock(Date.parse(peak.at)) })
        }
      />
      <StatCard
        label={m.overview_stat_total_label()}
        value={`${sandboxes.total} / ${sandboxes.maxSandboxes}`}
        hint={m.overview_stat_total_hint({ max: sandboxes.maxSandboxes })}
        sub={m.overview_stat_total_sub({ pct: capacityPct })}
        corner={
          <div className="w-20 shrink-0 pb-1.5 @[250px]/card:w-24">
            <Meter pct={capacityPct} />
          </div>
        }
        to="/sandboxes"
      />
      <SandboxDisksCard />
    </div>
  );
}
