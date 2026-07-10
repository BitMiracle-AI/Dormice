import { Badge } from '@/components/ui/badge';

/**
 * 挂在 mock 页面标题旁的诚实声明:这一页还没有服务端,数据是设计期的
 * 示例。生产构建里这些页面整个不出现(lib/mock.ts),这枚徽章管的是
 * dev 里看着它的人。
 */
export function SampleDataBadge() {
  return (
    <Badge
      variant="outline"
      className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    >
      示例数据
    </Badge>
  );
}
