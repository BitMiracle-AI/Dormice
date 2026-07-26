import {
  ArrowUpRight01Icon,
  Book02Icon,
  GithubIcon,
  Globe02Icon,
  Logout01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { CommandMenu } from '@/components/CommandMenu';
import { currentLocaleLabel, LocaleMenu } from '@/components/LocaleMenu';
import { menuButtonClass, NAV_GROUPS } from '@/components/nav';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { m } from '@/paraglide/messages';

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
  // 只读缓存:开台检查或版本页查过且有新版本才亮,角标自己绝不发请求。
  const upgradable = useCachedUpgradable();
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

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
        {/* ⌘K 命令面板:纯键盘入口,组件只挂快捷键和弹窗,不渲染可见节点。 */}
        <CommandMenu />
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter(
            (item) => !item.mock || MOCK_PAGES_ENABLED,
          );
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.id}>
              <SidebarGroupLabel>{group.label()}</SidebarGroupLabel>
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
                        <span>{item.label()}</span>
                      </SidebarMenuButton>
                      {item.mock && (
                        <SidebarMenuBadge>
                          {m.shell_preview_badge()}
                        </SidebarMenuBadge>
                      )}
                      {item.to === '/version' && upgradable && (
                        <SidebarMenuBadge>
                          <span
                            className="size-2 rounded-full bg-amber-500"
                            title={m.shell_upgradable_title()}
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
              {/* 右上角箭头 = 外链,新标签页打开的视觉承诺。 */}
              <HugeiconsIcon
                icon={ArrowUpRight01Icon}
                strokeWidth={2}
                className="ml-auto size-3.5 text-muted-foreground"
              />
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
              <span>{m.shell_docs()}</span>
              <HugeiconsIcon
                icon={ArrowUpRight01Icon}
                strokeWidth={2}
                className="ml-auto size-3.5 text-muted-foreground"
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/* 语言切换:菜单项文案 = 当前语言的本族语名,认出母语即入口。 */}
            <LocaleMenu
              trigger={
                <SidebarMenuButton className={menuButtonClass}>
                  <HugeiconsIcon icon={Globe02Icon} strokeWidth={2} />
                  <span>{currentLocaleLabel()}</span>
                </SidebarMenuButton>
              }
            />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              className={menuButtonClass}
              onClick={() => setLogoutConfirmOpen(true)}
            >
              <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
              <span>{m.shell_logout()}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* 退出确认:不是不可逆操作,但会话没了要重输密码,值得拦一下手滑。 */}
      <AlertDialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.shell_logout_confirm_title()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.shell_logout_confirm_desc()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.shell_logout_cancel()}</AlertDialogCancel>
            <AlertDialogAction onClick={signOut}>
              {m.shell_logout_action()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  );
}
