import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';

/** 分页窗口:最多 5 个页码,当前页居中,边界处贴边(openasi 同款)。 */
function pageWindow(current: number, total: number): number[] {
  const size = Math.min(5, total);
  let start = Math.max(1, current - 2);
  if (start + size - 1 > total) start = total - size + 1;
  return Array.from({ length: size }, (_, i) => start + i);
}

/**
 * 列表页底部的常驻分页条(openasi 版式,2026-07-16 用户拍板):左边
 * 「共 N 条」,右边上一页/页码/下一页 — 数据只有一页时也在,底部有没
 * 有这一条不该取决于数据多少。分页是纯前端的:列表本来就整份在手里
 * (轮询/环形记录),切页不打请求。
 */
export function TablePager({
  page,
  pageCount,
  total,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground tabular-nums">
        共 {total} 条,第 {page} / {pageCount} 页
      </p>
      <Pagination className="mx-0 w-auto justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              text="上一页"
              aria-disabled={page <= 1}
              className={
                page <= 1 ? 'pointer-events-none opacity-50' : undefined
              }
              onClick={() => onPageChange(Math.max(1, page - 1))}
            />
          </PaginationItem>
          {pageWindow(page, pageCount).map((p) => (
            <PaginationItem key={p}>
              <PaginationLink
                isActive={p === page}
                onClick={() => onPageChange(p)}
              >
                {p}
              </PaginationLink>
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext
              text="下一页"
              aria-disabled={page >= pageCount}
              className={
                page >= pageCount ? 'pointer-events-none opacity-50' : undefined
              }
              onClick={() => onPageChange(Math.min(pageCount, page + 1))}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

/**
 * 客户端分页的公分母:page 夹回合法区间(过滤把列表缩短时不留空页),
 * 返回当页切片。各列表页共用,别再各自发明。
 */
export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
): { rows: T[]; safePage: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  return {
    rows: items.slice((safePage - 1) * pageSize, safePage * pageSize),
    safePage,
    pageCount,
  };
}
