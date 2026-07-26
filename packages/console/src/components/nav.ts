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
import { m } from '@/paraglide/messages';

export interface NavItem {
  to: string;
  // label 是函数不是字符串:这个清单在模块顶层求值,直接取 m.xxx() 会把
  // 编译期 locale 烙死在常量里;由消费方在渲染时调用,才拿到当下语言。
  label: () => string;
  icon: NonNullable<HugeiconsProps['icon']>;
  /** 服务端还没有的页面:dev 里带"预览"角标,生产构建整个隐藏。 */
  mock?: boolean;
}

// 平台 = 管的对象(沙箱/模板),运维 = 管这台机器;连接页是给要接 SDK 的人。
// 独立成文件:侧栏与命令面板(⌘K)都要这份清单,留在任何一边都会让
// 两个组件互相 import。页面清单只有这一份,两处永远一致。
export const NAV_GROUPS: Array<{ label: () => string; items: NavItem[] }> = [
  {
    label: m.shell_nav_group_platform,
    items: [
      { to: '/', label: m.shell_nav_dashboard, icon: DashboardSquare01Icon },
      { to: '/sandboxes', label: m.shell_nav_sandboxes, icon: PackageIcon },
      { to: '/templates', label: m.shell_nav_templates, icon: Layers01Icon },
    ],
  },
  {
    label: m.shell_nav_group_ops,
    items: [
      { to: '/activity', label: m.shell_nav_activity, icon: Activity01Icon },
      { to: '/api-keys', label: m.shell_nav_api_keys, icon: Key01Icon },
      { to: '/domains', label: m.shell_nav_domains, icon: Globe02Icon },
      {
        to: '/doctor',
        label: m.shell_nav_doctor,
        icon: StethoscopeIcon,
        mock: true,
      },
      { to: '/settings', label: m.shell_nav_settings, icon: Settings01Icon },
      { to: '/version', label: m.shell_nav_version, icon: GitCommitIcon },
    ],
  },
  {
    label: m.shell_nav_group_access,
    items: [
      { to: '/connect', label: m.shell_nav_connect, icon: PlugSocketIcon },
    ],
  },
];

// 侧栏按钮统一药丸形 + medium 字重(风格参考 openasi 侧栏,2026-07-12)。
// cursor-default 抹平 Link(手型)与 button(箭头)的光标分裂 — 侧栏是
// 应用 chrome,不是网页链接。
export const menuButtonClass = 'rounded-full font-medium cursor-default';
