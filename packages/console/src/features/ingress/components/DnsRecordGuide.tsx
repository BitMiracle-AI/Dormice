import { Copy01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/copy';
import { m } from '@/paraglide/messages';

/**
 * "照抄一条解析记录"的指引块:要填什么直接给出来,可复制的值带复制
 * 按钮,用户不用猜。控制台域名绑定与沙箱域名弹窗共用 — 两边的体验
 * 必须是同一个。
 */
export function DnsRecordGuide({
  intro,
  rows,
  footnote,
}: {
  intro: string;
  rows: Array<{ label: string; value: string; copyable?: boolean }>;
  footnote?: string;
}) {
  return (
    <div className="rounded-md border bg-muted/30 px-4 py-3">
      <p className="text-xs text-muted-foreground">{intro}</p>
      <div className="mt-2 grid grid-cols-[4.5rem_1fr] items-center gap-y-1 font-mono text-xs">
        {rows.map((row) => (
          <div key={row.label} className="col-span-2 grid grid-cols-subgrid">
            <span className="text-muted-foreground">{row.label}</span>
            {row.copyable ? (
              <span className="flex items-center gap-1">
                {row.value}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={m.domains_copy_value_label()}
                  onClick={() =>
                    copyText(row.value).then(
                      () => toast.success(m.common_copied()),
                      () => toast.error(m.domains_copy_failed()),
                    )
                  }
                >
                  <HugeiconsIcon icon={Copy01Icon} />
                </Button>
              </span>
            ) : (
              <span>{row.value}</span>
            )}
          </div>
        ))}
      </div>
      {footnote && (
        <p className="mt-2 text-xs text-muted-foreground">{footnote}</p>
      )}
    </div>
  );
}
