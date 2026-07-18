'use client';

import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

// Clipboard needs the browser, so this is the one client island in the
// landing sections. The tick reverts on a timer; overlapping clicks just
// extend the confirmation, which is the behavior a user expects.
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Copy command"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} />
    </Button>
  );
}
