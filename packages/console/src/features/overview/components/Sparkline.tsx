import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * 迷你走势曲线(sparkline):统计卡右下角用,只表达「窗口内大致走势」,
 * 不带坐标轴/刻度/交互。纯 SVG path — 比每卡塞一个 recharts 容器轻得多,
 * viewBox + preserveAspectRatio 让曲线随容器自由拉伸。
 *
 * 用中性主色,刻意不做涨绿跌红:openasi 画的是钱,涨跌有好坏;活跃沙箱
 * 变多没有好坏(业务旺或泄漏都长这样),红绿会撒谎。
 * 平滑:相邻点取中点做二次贝塞尔,避免折线尖角;面积渐变填充到底,
 * 弱化为背景陪衬。
 */
const VIEW_W = 100;
const VIEW_H = 32;

export function Sparkline({
  data,
  className,
}: {
  data: number[];
  className?: string;
}) {
  const gradientId = useId();

  // 少于两点画不出走势;归一化到 viewBox,min→底、max→顶,曲线占 80%
  // 高度留出上下边距。
  const first = data[0];
  if (data.length < 2 || first === undefined) return null;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pad = VIEW_H * 0.1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * VIEW_W;
    const y = VIEW_H - pad - ((v - min) / range) * (VIEW_H - pad * 2);
    return { x, y };
  });

  const head = points[0];
  const tail = points[points.length - 1];
  if (head === undefined || tail === undefined) return null;
  let line = `M ${head.x} ${head.y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev === undefined || cur === undefined) continue;
    const midX = (prev.x + cur.x) / 2;
    const midY = (prev.y + cur.y) / 2;
    line += ` Q ${prev.x} ${prev.y} ${midX} ${midY}`;
  }
  line += ` L ${tail.x} ${tail.y}`;
  const area = `${line} L ${VIEW_W} ${VIEW_H} L 0 ${VIEW_H} Z`;

  const stroke = 'var(--primary)';

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      className={cn('h-8 w-full overflow-visible', className)}
      role="presentation"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
