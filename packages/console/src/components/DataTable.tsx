import type * as React from 'react';
import { Card } from '@/components/ui/card';
import { Table } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// 表格皮的唯一定义(参考 openasi 表格,2026-07-15 用户拍板):
// - 表头 h-12、单元格 px-4 py-2.5,首末列 24px 边距 — 内容离卡面圆角有喘息
// - 吸顶表头 bg-card 与卡面同色,滚动不穿帮;短表贴不到顶,无害
// - 行动画一律关闭:2 秒轮询重渲下 transition-colors 会微闪
const TABLE_CHROME =
  '[&_tr]:transition-none [&_th]:h-12 [&_th]:px-4 [&_td]:px-4 [&_td]:py-2.5 [&_th:first-child]:pl-6 [&_td:first-child]:pl-6 [&_th:last-child]:pr-6 [&_td:last-child]:pr-6 [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card';

/**
 * 数据表外壳:卡面(bg-card + 大圆角 + ring)包一层滚动容器,再套统一
 * 密度的 Table — 密度与边距只在这里定一次,全站表格共用,漂移无从发生。
 * 长表传 containerClassName="max-h-[70vh]" 限高框内滚,吸顶表头才有得贴。
 * vendored table.tsx 不动,覆写全在这一侧。
 */
export function DataTable({
  containerClassName,
  className,
  ...props
}: React.ComponentProps<typeof Table> & { containerClassName?: string }) {
  return (
    <Card className="p-0">
      {/* vendored Table 自带 overflow-x-auto 内容器 — 把它放开,让这层
          成为唯一滚动口:竖向吸顶与横向滚动发生在同一个容器上。 */}
      <div
        className={cn(
          'overflow-auto [&_[data-slot=table-container]]:overflow-visible',
          containerClassName,
        )}
      >
        <Table className={cn(TABLE_CHROME, className)} {...props} />
      </div>
    </Card>
  );
}
