import { Copy01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/copy';
import { m } from '@/paraglide/messages';

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
        aria-label={m.shell_copy_to_clipboard()}
        onClick={() =>
          copyText(code).then(
            () => toast.success(m.common_copied()),
            () => toast.error(m.shell_copy_failed_select()),
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
