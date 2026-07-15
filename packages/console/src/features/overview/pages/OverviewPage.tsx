import { useState } from 'react';
import { FleetChart } from '../components/FleetChart';
import { FleetStatCards } from '../components/FleetStatCards';
import { HostHealthCard } from '../components/HostHealthCard';
import { QuickConnectCard } from '../components/QuickConnectCard';
import { RangeSwitcher } from '../components/RangeSwitcher';
import { SandboxDisksCard } from '../components/SandboxDisksCard';
import type { TimelineRangeKey } from '../hooks/useFleetTimeline';

/**
 * 回答三个问题:沙箱群现在多忙、一段时间以来多忙(daemon 采样器落库
 * 的舰队时间线,含窗口峰值)、这台机器还好吗。版式参考 openasi 仪表盘:
 * 页头右侧的全局档位切换统一驱动统计卡与主图,主图区 3:1(走势图配
 * 宿主健康竖卡),底部一行沙箱磁盘账单 + 快速接入(「换两个 URL 直连」
 * 放上第一屏)。
 */
export function OverviewPage() {
  const [range, setRange] = useState<TimelineRangeKey>('24h');

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">仪表盘</h1>
          <p className="text-sm text-muted-foreground">
            沙箱群的并发走势,与这台机器的健康状况。
          </p>
        </div>
        <RangeSwitcher range={range} onChange={setRange} />
      </div>
      <FleetStatCards range={range} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <FleetChart range={range} className="min-h-[420px] lg:col-span-3" />
        <HostHealthCard className="min-h-[420px] lg:col-span-1" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <SandboxDisksCard />
        <QuickConnectCard />
      </div>
    </>
  );
}
