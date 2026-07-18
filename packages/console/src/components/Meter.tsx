import { cn } from '@/lib/utils';

/**
 * Usage meter: the fill carries severity (quiet below 75%, amber to 90%,
 * red past it) and the unfilled track is a lighter step of the same color,
 * so state reads across the whole bar. Null means "no reading yet" — an
 * empty quiet track, never a fake zero fill.
 *
 * The three fills are the SAME tokens the usage text next to them uses
 * (muted-foreground / amber-600·400 / red-600·400, thresholds shared at
 * 75/90) — the bar is the number's shadow, so the two may never disagree
 * in hue. Quiet is deliberately not bg-primary: an accent-colored bar
 * beside gray text read as two systems.
 */
export function Meter({ pct }: { pct: number | null }) {
  const clamped = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const [fill, track] =
    clamped >= 90
      ? ['bg-red-600 dark:bg-red-400', 'bg-red-600/15 dark:bg-red-400/15']
      : clamped >= 75
        ? [
            'bg-amber-600 dark:bg-amber-400',
            'bg-amber-600/15 dark:bg-amber-400/15',
          ]
        : ['bg-muted-foreground', 'bg-muted-foreground/15'];
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full', track)}>
      <div
        className={cn('h-full rounded-full transition-[width]', fill)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
