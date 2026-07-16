import {
  Book02Icon,
  GithubIcon,
  Logout01Icon,
  Moon02Icon,
  Sun02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useTheme } from 'next-themes';
import { CommandMenu } from '@/components/CommandMenu';
import { menuButtonClass, NAV_GROUPS } from '@/components/nav';
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

async function signOut() {
  // 尽力而为:cookie 可能已经死了,无所谓 — 清掉标记回登录页才是正事。
  await logout().catch(() => undefined);
  clearSessionMarker();
  window.location.href = '/console/login';
}

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
        {/* ⌘K 搜索入口:顶栏删掉后(2026-07-16)它是全站搜索唯一的可见入口。 */}
        <SidebarMenu>
          <CommandMenu />
        </SidebarMenu>
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
                      {item.to === '/version' && upgradable && (
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
          {/* 项目主页与文档站(2026-07-16 用户拍板):真外链,新标签页打开。 */}
          <SidebarMenuItem>
            <SidebarMenuButton
              className={menuButtonClass}
              render={
                <a
                  href="https://github.com/BitMiracle-AI/Dormice"
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              <HugeiconsIcon icon={GithubIcon} strokeWidth={2} />
              <span>GitHub</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              className={menuButtonClass}
              render={
                <a
                  href="https://dormice.dev"
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              <HugeiconsIcon icon={Book02Icon} strokeWidth={2} />
              <span>文档</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
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
