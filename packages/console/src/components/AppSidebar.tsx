import {
  Activity01Icon,
  DashboardSquare01Icon,
  Globe02Icon,
  Key01Icon,
  Layers01Icon,
  Logout01Icon,
  Moon02Icon,
  PackageIcon,
  PlugSocketIcon,
  Settings01Icon,
  StethoscopeIcon,
  Sun02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useTheme } from 'next-themes';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useCachedUpgradable } from '@/features/settings/hooks/useUpgrade';
import { logout } from '@/lib/api';
import { MOCK_PAGES_ENABLED } from '@/lib/mock';
import { clearSessionMarker } from '@/lib/session';

interface NavItem {
  to: string;
  label: string;
  icon: NonNullable<HugeiconsProps['icon']>;
  /** 服务端还没有的页面:dev 里带"预览"角标,生产构建整个隐藏。 */
  mock?: boolean;
}

// 平台 = 管的对象(沙箱/模板),运维 = 管这台机器;连接页是给要接 SDK 的人。
// 导出给命令面板(⌘K)复用 — 页面清单只有这一份,两处永远一致。
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
    ],
  },
  {
    label: '接入',
    items: [{ to: '/connect', label: '连接', icon: PlugSocketIcon }],
  },
];

async function signOut() {
  // 尽力而为:cookie 可能已经死了,无所谓 — 清掉标记回登录页才是正事。
  await logout().catch(() => undefined);
  clearSessionMarker();
  window.location.href = '/console/login';
}

// 侧栏按钮统一药丸形 + medium 字重(风格参考 openasi 侧栏,2026-07-12)。
// cursor-default 抹平 Link(手型)与 button(箭头)的光标分裂 — 侧栏是
// 应用 chrome,不是网页链接。
const menuButtonClass = 'rounded-full font-medium cursor-default';

function isActivePath(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AppSidebar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { resolvedTheme, setTheme } = useTheme();
  // 只读缓存:设置页查过且有新版本才亮,角标自己绝不发请求。
  const upgradable = useCachedUpgradable();

  return (
    <Sidebar variant="inset" className="px-1">
      <SidebarHeader>
        {/* 纯文字 wordmark:侧栏融在页面底色里,不需要图标方块撑品牌。 */}
        <Link
          to="/"
          className="flex cursor-default items-center px-2.5 pt-2 pb-1.5"
        >
          <span className="text-lg font-semibold leading-none [font-family:'Google_Sans',sans-serif]">
            Dormice
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter(
            (item) => !item.mock || MOCK_PAGES_ENABLED,
          );
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        className={menuButtonClass}
                        isActive={isActivePath(pathname, item.to)}
                        render={<Link to={item.to} />}
                      >
                        <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                      {item.mock && <SidebarMenuBadge>预览</SidebarMenuBadge>}
                      {item.to === '/settings' && upgradable && (
                        <SidebarMenuBadge>
                          <span
                            className="size-2 rounded-full bg-amber-500"
                            title="有新版本可升级"
                          />
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className={menuButtonClass}
              onClick={() =>
                setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
              }
            >
              <HugeiconsIcon
                icon={resolvedTheme === 'dark' ? Sun02Icon : Moon02Icon}
                strokeWidth={2}
              />
              <span>{resolvedTheme === 'dark' ? '浅色模式' : '深色模式'}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton className={menuButtonClass} onClick={signOut}>
              <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
              <span>退出登录</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
