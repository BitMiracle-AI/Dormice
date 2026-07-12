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

/**
 * 沙箱的下一步降温:与 daemon 扫描器同一套语义 — 空闲时长从
 * lastActiveAt 起算,按当前状态取对应旋钮,一次只降一档。旋钮为 null
 * 表示这一档永不发生(常驻);active 的冻结旋钮不可为 null。到点未动
 * 是正常态(等下一轮扫描),remainingSeconds 为 0 而不是负数。
 * archived/restoring 没有下一步,返回 null。
 */
export function nextLifecycleStep(
  sandbox: Pick<Sandbox, 'state' | 'lastActiveAt' | 'policy'>,
  nowMs: number,
): {
  action: '冻结' | '停止' | '归档';
  remainingSeconds: number | null;
} | null {
  const idle = (nowMs - Date.parse(sandbox.lastActiveAt)) / 1000;
  const remaining = (threshold: number) => Math.max(0, threshold - idle);
  switch (sandbox.state) {
    case 'active':
      return {
        action: '冻结',
        remainingSeconds: remaining(sandbox.policy.freezeAfterSeconds),
      };
    case 'frozen':
      return sandbox.policy.stopAfterSeconds === null
        ? { action: '停止', remainingSeconds: null }
        : {
            action: '停止',
            remainingSeconds: remaining(sandbox.policy.stopAfterSeconds),
          };
    case 'stopped':
      return sandbox.policy.archiveAfterSeconds === null
        ? { action: '归档', remainingSeconds: null }
        : {
            action: '归档',
            remainingSeconds: remaining(sandbox.policy.archiveAfterSeconds),
          };
    default:
      return null;
  }
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
