import type { SandboxState } from '@dormice/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { STATE_LABELS } from '../format';

// Lifecycle rungs, coldest last — one hue per rung so the list reads at a
// glance: green is paying for RAM, blue is parked in swap, grey is disk-only.
const STATE_STYLES: Record<SandboxState, string> = {
  active:
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  frozen: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  stopped: 'border-border bg-muted text-muted-foreground',
  archived:
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  restoring:
    'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

export function SandboxStateBadge({ state }: { state: SandboxState }) {
  return (
    <Badge variant="outline" className={cn('font-medium', STATE_STYLES[state])}>
      {STATE_LABELS[state]}
    </Badge>
  );
}
