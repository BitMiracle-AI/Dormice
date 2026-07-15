import type { ActivityKind } from '@dormice/shared';

/**
 * 事件的中文名与徽章配色 — 与 wire 上的 kind 一比一,这里是唯一的翻译点。
 * 活动页与沙箱详情页的历史 tab 共用,不各自翻译。
 */
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  created: '创建',
  woken: '唤醒',
  frozen: '冻结',
  stopped: '停止',
  rebuilt: '重建',
  destroyed: '销毁',
  'expired-killed': '到期销毁',
  archived: '归档',
  'restore-started': '开始恢复',
  restored: '恢复完成',
  'restore-failed': '恢复失败',
  reconciled: '对账修复',
  'policy-changed': '策略调整',
  'daemon-started': 'daemon 启动',
  'ingress-updated': '域名配置',
  'upgrade-started': '发起升级',
};

// 事件色与沙箱状态徽章同一色系:落到哪个状态就穿哪个颜色;
// 配置类事件(策略、域名)统一紫色。
export const ACTIVITY_KIND_STYLES: Record<ActivityKind, string> = {
  created:
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  woken:
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  frozen: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  stopped: 'border-border bg-muted text-muted-foreground',
  rebuilt:
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  destroyed: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  'expired-killed':
    'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  archived:
    'border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  'restore-started':
    'border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  restored:
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  'restore-failed':
    'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  reconciled:
    'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  'policy-changed':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'daemon-started': 'border-border bg-muted text-muted-foreground',
  'ingress-updated':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'upgrade-started':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
};
