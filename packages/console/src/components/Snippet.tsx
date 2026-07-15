import { Copy01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/copy';

/**
 * A copyable code block — the connect page's and the overview's shared
 * snippet skin, one copy button in the corner, toast on both outcomes.
 */
export function Snippet({ code }: { code: string }) {
  return (
    <div className="relative rounded-md border bg-muted/30">
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-1.5 right-1.5"
        aria-label="复制到剪贴板"
        onClick={() =>
          copyText(code).then(
            () => toast.success('已复制'),
            () => toast.error('复制失败 — 请手动选中文本'),
          )
        }
      >
        <HugeiconsIcon icon={Copy01Icon} />
      </Button>
      <pre className="overflow-x-auto p-4 pr-12 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
