import { OverviewCards } from '../components/OverviewCards';

/**
 * 回答两个问题:这台机器还好吗、这群沙箱花了它多少。数字全部来自
 * /getHostMetrics 单次快照 — 观察窗,不是监控系统。
 */
export function OverviewPage() {
  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">总览</h1>
        <p className="text-sm text-muted-foreground">
          这台机器的健康状况,与沙箱群花掉的资源。
        </p>
      </div>
      <OverviewCards />
    </>
  );
}
