import type { ActivityKind } from '@dormice/shared';
import { m } from '@/paraglide/messages';

/**
 * 事件的显示名与徽章配色 — 与 wire 上的 kind 一比一,这里是唯一的翻译点。
 * 活动页与沙箱工作台共用,不各自翻译。函数形式(而非常量表)是刻意的:
 * 消息要在渲染时按当前 locale 取值。
 */
export function activityKindLabel(kind: ActivityKind): string {
  switch (kind) {
    case 'created':
      return m.activity_kind_created();
    case 'woken':
      return m.activity_kind_woken();
    case 'frozen':
      return m.activity_kind_frozen();
    case 'stopped':
      return m.activity_kind_stopped();
    case 'rebuilt':
      return m.activity_kind_rebuilt();
    case 'destroyed':
      return m.activity_kind_destroyed();
    case 'expired-killed':
      return m.activity_kind_expired_killed();
    case 'archived':
      return m.activity_kind_archived();
    case 'restore-started':
      return m.activity_kind_restore_started();
    case 'restored':
      return m.activity_kind_restored();
    case 'restore-failed':
      return m.activity_kind_restore_failed();
    case 'reconciled':
      return m.activity_kind_reconciled();
    case 'policy-changed':
      return m.activity_kind_policy_changed();
    case 'metadata-changed':
      return m.activity_kind_metadata_changed();
    case 'spec-changed':
      return m.activity_kind_spec_changed();
    case 'disk-expanded':
      return m.activity_kind_disk_expanded();
    case 'daemon-started':
      return m.activity_kind_daemon_started();
    case 'ingress-updated':
      return m.activity_kind_ingress_updated();
    case 'settings-updated':
      return m.activity_kind_settings_updated();
    case 'apikey-created':
      return m.activity_kind_apikey_created();
    case 'apikey-updated':
      return m.activity_kind_apikey_updated();
    case 'apikey-disabled':
      return m.activity_kind_apikey_disabled();
    case 'apikey-enabled':
      return m.activity_kind_apikey_enabled();
    case 'apikey-revoked':
      return m.activity_kind_apikey_revoked();
    case 'upgrade-started':
      return m.activity_kind_upgrade_started();
  }
}

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
  'metadata-changed':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'spec-changed':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'disk-expanded':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'daemon-started': 'border-border bg-muted text-muted-foreground',
  'ingress-updated':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'settings-updated':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'apikey-created':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'apikey-updated':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'apikey-disabled':
    'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  'apikey-enabled':
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  'apikey-revoked':
    'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  'upgrade-started':
    'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
};
