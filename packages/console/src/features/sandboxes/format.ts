import type { Sandbox } from '@dormice/shared';

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400)
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function since(iso: string): string {
  return formatDuration((Date.now() - Date.parse(iso)) / 1000);
}

/** One knob as text: "freeze 5m" / "stop never". */
export function policyStep(label: string, seconds: number | null): string {
  return seconds === null
    ? `${label} never`
    : `${label} ${formatDuration(seconds)}`;
}

/** The three knobs in one line: how this sandbox cools down when idle. */
export function policyLine(policy: Sandbox['policy']): string {
  return [
    policyStep('freeze', policy.freezeAfterSeconds),
    policyStep('stop', policy.stopAfterSeconds),
    policyStep('archive', policy.archiveAfterSeconds),
  ].join(' · ');
}
