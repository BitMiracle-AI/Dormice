import type { Sandbox, SandboxState } from '@dormice/shared';
import { m } from '@/paraglide/messages';

/** 状态名 — 徽章、筛选器、总览统计共用一份,不各自翻译。 */
export function stateLabel(state: SandboxState): string {
  switch (state) {
    case 'active':
      return m.common_state_active();
    case 'frozen':
      return m.common_state_frozen();
    case 'stopped':
      return m.common_state_stopped();
    case 'archived':
      return m.common_state_archived();
    case 'restoring':
      return m.common_state_restoring();
  }
}

/**
 * 五态的颜色,单一来源:dot 是文字旁小圆点的 tailwind 类,chart 是
 * 堆叠面积图的填充色(明暗两面各自过了 dataviz 验证器:亮面 600 级、
 * 暗面紫色升回 500——相邻对 CVD 分离与 3:1 对比度全过)。stopped 刻意
 * 是灰:熄灭态读作灰正是它的含义,身份另由图例、tooltip 与固定堆叠位
 * 承载。色相与 SandboxStateBadge 同族,整站读作一套系统。
 */
export const STATE_COLORS: Record<
  SandboxState,
  { dot: string; chart: { light: string; dark: string } }
> = {
  active: {
    dot: 'bg-emerald-500',
    chart: { light: '#059669', dark: '#059669' },
  },
  frozen: { dot: 'bg-sky-500', chart: { light: '#0284c7', dark: '#0284c7' } },
  stopped: {
    dot: 'bg-muted-foreground/50',
    chart: { light: '#64748b', dark: '#64748b' },
  },
  archived: {
    dot: 'bg-violet-500',
    chart: { light: '#7c3aed', dark: '#8b5cf6' },
  },
  restoring: {
    dot: 'bg-amber-500',
    chart: { light: '#d97706', dark: '#d97706' },
  },
};

/** 时长写法:45秒 / 5分12秒 / 3小时20分 / 2天4小时(en: 45s / 5m 12s),最多两段。 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return m.common_duration_seconds({ n: s });
  if (s < 3600) {
    const rest = s % 60;
    return rest === 0
      ? m.common_duration_minutes({ n: Math.floor(s / 60) })
      : m.common_duration_minutes_seconds({ m: Math.floor(s / 60), s: rest });
  }
  if (s < 86400) {
    const rest = Math.floor((s % 3600) / 60);
    return rest === 0
      ? m.common_duration_hours({ n: Math.floor(s / 3600) })
      : m.common_duration_hours_minutes({ h: Math.floor(s / 3600), m: rest });
  }
  const rest = Math.floor((s % 86400) / 3600);
  return rest === 0
    ? m.common_duration_days({ n: Math.floor(s / 86400) })
    : m.common_duration_days_hours({ d: Math.floor(s / 86400), h: rest });
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

/**
 * 相对时刻,粗粒度:"刚刚" / "5 分钟前" / "3 小时前" / "2 天前"。
 * 刻意只留一段 — "3小时20分前"的后一段是噪音,读者要的是数量级;
 * 精确到秒的场合(策略倒计时)用 formatDuration,精确时刻在 title。
 * "前"字在消息里自带:"刚刚"没有"前",由调用方拼会拼出"刚刚前"。
 */
export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return m.common_just_now();
  if (s < 3600) return m.common_minutes_ago({ n: Math.floor(s / 60) });
  if (s < 86400) return m.common_hours_ago({ n: Math.floor(s / 3600) });
  return m.common_days_ago({ n: Math.floor(s / 86400) });
}

/** 距离某时刻还有多久:"6天3小时"(调用方自己加"后");已过去则为"0秒"。 */
export function until(iso: string): string {
  return formatDuration((Date.parse(iso) - Date.now()) / 1000);
}

/** 三旋钮的降温动作,wire 语义键 — 展示时经 policyActionLabel 翻译。 */
export type PolicyAction = 'freeze' | 'stop' | 'archive';

/** 降温动作名的唯一翻译点:徽章、倒计时、策略行共用。 */
export function policyActionLabel(action: PolicyAction): string {
  switch (action) {
    case 'freeze':
      return m.common_policy_freeze();
    case 'stop':
      return m.common_policy_stop();
    case 'archive':
      return m.common_policy_archive();
  }
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
  action: PolicyAction;
  remainingSeconds: number | null;
} | null {
  const idle = (nowMs - Date.parse(sandbox.lastActiveAt)) / 1000;
  const remaining = (threshold: number) => Math.max(0, threshold - idle);
  switch (sandbox.state) {
    case 'active':
      return {
        action: 'freeze',
        remainingSeconds: remaining(sandbox.policy.freezeAfterSeconds),
      };
    case 'frozen':
      return sandbox.policy.stopAfterSeconds === null
        ? { action: 'stop', remainingSeconds: null }
        : {
            action: 'stop',
            remainingSeconds: remaining(sandbox.policy.stopAfterSeconds),
          };
    case 'stopped':
      return sandbox.policy.archiveAfterSeconds === null
        ? { action: 'archive', remainingSeconds: null }
        : {
            action: 'archive',
            remainingSeconds: remaining(sandbox.policy.archiveAfterSeconds),
          };
    default:
      return null;
  }
}

/** 一个旋钮的文字形:"冻结 5分钟" / "停止 永不"。 */
export function policyStep(
  action: PolicyAction,
  seconds: number | null,
): string {
  const label = policyActionLabel(action);
  return seconds === null
    ? `${label} ${m.common_policy_never()}`
    : `${label} ${formatDuration(seconds)}`;
}

/** 三个旋钮一行:这个沙箱闲下来之后怎么降温。 */
export function policyLine(policy: Sandbox['policy']): string {
  return [
    policyStep('freeze', policy.freezeAfterSeconds),
    policyStep('stop', policy.stopAfterSeconds),
    policyStep('archive', policy.archiveAfterSeconds),
  ].join(' · ');
}
