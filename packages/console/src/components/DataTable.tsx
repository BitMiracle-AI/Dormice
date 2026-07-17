import type * as React from 'react';
import { Card } from '@/components/ui/card';
import { Table } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// 表格皮的唯一定义(参考 openasi 表格,2026-07-15 用户拍板):
// - 行定高 h-13,表头表行同高(2026-07-18 拍板)— 行高不随内容深浅
//   跳动;表格里 height 是下限,超高内容仍会诚实撑开而不是被裁
// - 单元格 px-4 py-2.5,首末列 24px 边距 — 内容离卡面圆角有喘息
// - 吸顶表头 bg-card 与卡面同色,滚动不穿帮;短表贴不到顶,无害
// - 行动画一律关闭:2 秒轮询重渲下 transition-colors 会微闪
const TABLE_CHROME =
  '[&_tr]:transition-none [&_tr]:h-13 [&_th]:px-4 [&_td]:px-4 [&_td]:py-2.5 [&_th:first-child]:pl-6 [&_td:first-child]:pl-6 [&_th:last-child]:pr-6 [&_td:last-child]:pr-6 [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card';

/**
 * 数据表外壳:卡面(bg-card + 大圆角 + ring)包一层滚动容器,再套统一
 * 密度的 Table — 密度与边距只在这里定一次,全站表格共用,漂移无从发生。
 * vendored table.tsx 不动,覆写全在这一侧。
 *
 * 两种形态:
 * - 默认:卡面随内容长高,长表可传 containerClassName="max-h-[70vh]"
 *   限高框内滚(详情页 tab 内的面板用这种)。
 * - fill(openasi 列表页版式,2026-07-16 用户拍板):卡面吃掉父级 flex
 *   列的全部剩余高度,行多在框内滚、行少留白 — 无论数据多少,表格都
 *   占满页面剩余空间,分页条得以钉在底部。要求父链有确定高度
 *   (AppShell 已锁 h-svh,页面容器用 h-full flex-col)。
 */
export function DataTable({
  fill = false,
  containerClassName,
  className,
  ...props
}: React.ComponentProps<typeof Table> & {
  fill?: boolean;
  containerClassName?: string;
}) {
  return (
    <Card className={cn('p-0', fill && 'min-h-0 flex-1 overflow-hidden')}>
      {/* vendored Table 自带 overflow-x-auto 内容器 — 把它放开,让这层
          成为唯一滚动口:竖向吸顶与横向滚动发生在同一个容器上。 */}
      <div
        className={cn(
          'overflow-auto [&_[data-slot=table-container]]:overflow-visible',
          fill && 'min-h-0 flex-1',
          containerClassName,
        )}
      >
        <Table className={cn(TABLE_CHROME, className)} {...props} />
      </div>
    </Card>
  );
}
