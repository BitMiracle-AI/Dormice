import {
  Activity01Icon,
  DashboardSquare01Icon,
  GitCommitIcon,
  Globe02Icon,
  Key01Icon,
  Layers01Icon,
  PackageIcon,
  PlugSocketIcon,
  Settings01Icon,
  StethoscopeIcon,
} from '@hugeicons/core-free-icons';
import type { HugeiconsProps } from '@hugeicons/react';

export interface NavItem {
  to: string;
  label: string;
  icon: NonNullable<HugeiconsProps['icon']>;
  /** 服务端还没有的页面:dev 里带"预览"角标,生产构建整个隐藏。 */
  mock?: boolean;
}

// 平台 = 管的对象(沙箱/模板),运维 = 管这台机器;连接页是给要接 SDK 的人。
// 独立成文件:侧栏与命令面板(⌘K)都要这份清单,而搜索入口住在侧栏里,
// 留在任何一边都会让两个组件互相 import。页面清单只有这一份,两处永远一致。
export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '平台',
    items: [
      { to: '/', label: '仪表盘', icon: DashboardSquare01Icon },
      { to: '/sandboxes', label: '沙箱', icon: PackageIcon },
      { to: '/templates', label: '模板', icon: Layers01Icon },
    ],
  },
  {
    label: '运维',
    items: [
      { to: '/activity', label: '活动', icon: Activity01Icon },
      { to: '/api-keys', label: 'API 密钥', icon: Key01Icon },
      { to: '/domains', label: '域名', icon: Globe02Icon },
      { to: '/doctor', label: '体检', icon: StethoscopeIcon, mock: true },
      { to: '/settings', label: '设置', icon: Settings01Icon },
      { to: '/version', label: '版本', icon: GitCommitIcon },
    ],
  },
  {
    label: '接入',
    items: [{ to: '/connect', label: '连接', icon: PlugSocketIcon }],
  },
];

// 侧栏按钮统一药丸形 + medium 字重(风格参考 openasi 侧栏,2026-07-12)。
// cursor-default 抹平 Link(手型)与 button(箭头)的光标分裂 — 侧栏是
// 应用 chrome,不是网页链接。搜索入口(CommandMenu)也穿这一件。
export const menuButtonClass = 'rounded-full font-medium cursor-default';
