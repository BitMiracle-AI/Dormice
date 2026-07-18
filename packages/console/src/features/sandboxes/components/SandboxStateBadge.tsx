import type { SandboxState } from '@dormice/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { STATE_LABELS } from '../format';

// Lifecycle rungs, coldest last — one hue per rung so the list reads at a
// glance: green is paying for RAM, blue is parked in swap, grey is disk-only.
// Borderless (2026-07-18): tinted fill + colored text already carry the
// state; a same-hue outline was a third voice saying the same thing.
const STATE_STYLES: Record<SandboxState, string> = {
  active: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  frozen: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  stopped: 'bg-muted text-muted-foreground',
  archived: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  restoring: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

export function SandboxStateBadge({ state }: { state: SandboxState }) {
  return (
    <Badge
      variant="outline"
      className={cn('border-transparent font-medium', STATE_STYLES[state])}
    >
      {STATE_LABELS[state]}
    </Badge>
  );
}
