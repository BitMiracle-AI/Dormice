import { useState } from 'react';
import { FleetChart } from '../components/FleetChart';
import { FleetStatCards } from '../components/FleetStatCards';
import { HostHealthCard } from '../components/HostHealthCard';
import { QuickConnectCard } from '../components/QuickConnectCard';
import { RangeSwitcher } from '../components/RangeSwitcher';
import type { TimelineRangeKey } from '../hooks/useFleetTimeline';

/**
 * 回答三个问题:沙箱群现在多忙、一段时间以来多忙(daemon 采样器落库
 * 的舰队时间线,含窗口峰值)、这台机器还好吗。版式仿 openasi 仪表盘
 * (2026-07-16 用户拍板对齐页头与容器):max-w-6xl 限宽居中,页头一行
 * 标题 + 全局档位,顶排四张统计卡(沙箱磁盘也在其中),主图区 3:1
 * (走势图配宿主健康竖卡),底部快速接入(「换两个 URL 直连」放上第一屏)。
 */
export function OverviewPage() {
  const [range, setRange] = useState<TimelineRangeKey>('24h');

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-medium">仪表盘</h1>
        <RangeSwitcher range={range} onChange={setRange} />
      </header>
      <FleetStatCards range={range} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <FleetChart range={range} className="min-h-[420px] lg:col-span-3" />
        <HostHealthCard range={range} className="min-h-[420px] lg:col-span-1" />
      </div>
      <QuickConnectCard />
    </div>
  );
}
