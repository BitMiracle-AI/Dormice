import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * 统计卡解剖(参考 openasi SectionCards):小标签 + 大数字(容器查询下
 * 响应式放大)+ footer 左侧两行说明、右下角一个陪衬件(sparkline 或
 * 容量量表)。刻意没有环比百分比 — 「活跃比上窗口多 30%」没有行动
 * 含义,是装饰性精确。
 */
export function StatCard({
  label,
  value,
  hint,
  sub,
  corner,
  to,
}: {
  label: string;
  value: string;
  hint: string;
  sub: ReactNode;
  /** footer 右下角的陪衬件:sparkline、量表 — 没有就留白。 */
  corner?: ReactNode;
  /** 这张卡下钻的路由;只有真有去处的卡才给。 */
  to?: string;
}) {
  const card = (
    <Card size="sm" className="@container/card">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {value}
        </CardTitle>
      </CardHeader>
      <CardFooter className="flex items-end justify-between gap-3 text-sm">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="line-clamp-1 font-medium">{hint}</div>
          <div className="text-muted-foreground">{sub}</div>
        </div>
        {corner}
      </CardFooter>
    </Card>
  );
  if (!to) return card;
  // Radius mirrors the Card's own, so the focus/hover ring hugs the shape.
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
 * 骨架镜像真实解剖:header 标签 + 大数字,footer 两行说明 + 右下角
 * 陪衬件,块高对齐文字行高 — loading 与 loaded 等高不跳动。
 */
export function StatCardSkeleton() {
  return (
    <Card size="sm" className="@container/card">
      <CardHeader>
        <CardDescription>
          <Skeleton className="h-5 w-20" />
        </CardDescription>
        <CardTitle className="text-2xl font-semibold @[250px]/card:text-3xl">
          <Skeleton className="h-8 w-24 @[250px]/card:h-9" />
        </CardTitle>
      </CardHeader>
      <CardFooter className="flex items-end justify-between gap-3 text-sm">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="h-8 w-20 rounded-md" />
      </CardFooter>
    </Card>
  );
}
