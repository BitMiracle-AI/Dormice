import { cn } from '@/lib/utils';

/**
 * Usage meter: the fill carries severity (quiet below 75%, amber to 90%,
 * red past it) and the unfilled track is a lighter step of the same color,
 * so state reads across the whole bar. Null means "no reading yet" — an
 * empty quiet track, never a fake zero fill.
 */
export function Meter({ pct }: { pct: number | null }) {
  const clamped = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const [fill, track] =
    clamped >= 90
      ? ['bg-red-500', 'bg-red-500/15']
      : clamped >= 75
        ? ['bg-amber-500', 'bg-amber-500/15']
        : ['bg-primary', 'bg-primary/10'];
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full', track)}>
      <div
        className={cn('h-full rounded-full transition-[width]', fill)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
