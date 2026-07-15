import { FleetOverview } from '../components/FleetOverview';
import { OverviewCards } from '../components/OverviewCards';

/**
 * 回答三个问题:沙箱群现在多忙、一段时间以来多忙(daemon 采样器落库的
 * 舰队时间线,含窗口峰值)、这台机器还好吗。当前值来自 /getHostMetrics
 * 快照,走势来自 /getFleetTimeline 历史;快速接入卡把「换两个 URL 直连」
 * 放上第一屏。
 */
export function OverviewPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">仪表盘</h1>
        <p className="text-sm text-muted-foreground">
          沙箱群的并发走势,与这台机器的健康状况。
        </p>
      </div>
      <FleetOverview />
      <OverviewCards />
    </>
  );
}
