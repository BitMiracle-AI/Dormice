import type { ListSandboxImagesResponse } from '@dormice/shared';
import { Badge } from '@/components/ui/badge';

type ImageLineage = ListSandboxImagesResponse['images'][number];

/**
 * 「可升级」= 当前壳的出生镜像 ≠ 模板当前镜像,daemon 已经裁决好
 * (upgradable 字段),这里只负责显示。Rebuild 是升级的正门:换壳保盘,
 * 下一次使用跑在新镜像上——标记只指路,动作在详情页的 Rebuild 按钮。
 * 文案只活在这一个组件里(单一翻译点,同 STATE_LABELS 的纪律)。
 */
export function UpgradableBadge({ lineage }: { lineage?: ImageLineage }) {
  if (!lineage?.upgradable) return null;
  return (
    <Badge
      variant="outline"
      className="border-amber-500/40 bg-amber-500/10 font-medium text-amber-600 dark:text-amber-400"
      title={`运行 ${lineage.image},模板当前 ${lineage.nextImage} — Rebuild 换新`}
    >
      可升级
    </Badge>
  );
}
