import { Meter } from '@/components/Meter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatBytes, pctOf } from '@/lib/format';
import { useHostMetrics } from '../hooks/useHostMetrics';
import { StatCard, StatCardSkeleton } from './StatCard';

/**
 * 沙箱磁盘账单卡:这群沙箱的盘许诺了多少、实际占了多少 — 稀疏镜像
 * 只为真实内容付费,这两个数的差就是超卖的空间。机器本身的体征在
 * 宿主健康卡;这张卡讲的是沙箱群欠机器多少。
 */
export function SandboxDisksCard() {
  const query = useHostMetrics();

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{query.error.message}</AlertDescription>
      </Alert>
    );
  }

  if (!query.data) return <StatCardSkeleton />;

  const { sandboxDisks } = query.data;
  const usedPct = Math.round(
    pctOf(sandboxDisks.actualBytes, sandboxDisks.nominalBytes),
  );

  return (
    <StatCard
      label="沙箱磁盘"
      // 稀疏镜像只为真实内容付费:大数字是实占,hint 是许诺 — 差值即超卖。
      // 四列布局下 footer 左栏只有 8 个汉字宽,文案按这个上限写。
      value={formatBytes(sandboxDisks.actualBytes)}
      hint={`共许诺 ${formatBytes(sandboxDisks.nominalBytes)}`}
      sub={`${sandboxDisks.count} 块盘 · 实占 ${usedPct}%`}
      corner={
        <div className="w-20 shrink-0 pb-1.5 @[250px]/card:w-24">
          <Meter pct={usedPct} />
        </div>
      }
      to="/sandboxes"
    />
  );
}
