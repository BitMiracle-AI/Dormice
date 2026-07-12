import type { Sandbox, SandboxState } from '@dormice/shared';

/** 中文状态名 — 徽章、筛选器、总览统计共用一份,不各自翻译。 */
export const STATE_LABELS: Record<SandboxState, string> = {
  active: '运行中',
  frozen: '已冻结',
  stopped: '已停止',
  archived: '已归档',
  restoring: '恢复中',
};

/** 时长的中文写法:45秒 / 5分12秒 / 3小时20分 / 2天4小时,最多两段。 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}秒`;
  if (s < 3600) {
    const rest = s % 60;
    return rest === 0
      ? `${Math.floor(s / 60)}分钟`
      : `${Math.floor(s / 60)}分${rest}秒`;
  }
  if (s < 86400) {
    const rest = Math.floor((s % 3600) / 60);
    return rest === 0
      ? `${Math.floor(s / 3600)}小时`
      : `${Math.floor(s / 3600)}小时${rest}分`;
  }
  const rest = Math.floor((s % 86400) / 3600);
  return rest === 0
    ? `${Math.floor(s / 86400)}天`
    : `${Math.floor(s / 86400)}天${rest}小时`;
}

/**
 * 秒数输入框旁的实时换算:"259200" → "= 3天"。展示侧全说人话,输入侧
 * 不该让用户心算 — 空值或非法值返回 null,让固定文案独自站着。
 */
export function durationHint(raw: string): string | null {
  const seconds = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return `= ${formatDuration(seconds)}`;
}

/** 距离某时刻过去了多久:"3分12秒"(调用方自己加"前")。 */
export function since(iso: string): string {
  return formatDuration((Date.now() - Date.parse(iso)) / 1000);
}

/** 一个旋钮的文字形:"冻结 5分钟" / "停止 永不"。 */
export function policyStep(label: string, seconds: number | null): string {
  return seconds === null
    ? `${label} 永不`
    : `${label} ${formatDuration(seconds)}`;
}

/** 三个旋钮一行:这个沙箱闲下来之后怎么降温。 */
export function policyLine(policy: Sandbox['policy']): string {
  return [
    policyStep('冻结', policy.freezeAfterSeconds),
    policyStep('停止', policy.stopAfterSeconds),
    policyStep('归档', policy.archiveAfterSeconds),
  ].join(' · ');
}
