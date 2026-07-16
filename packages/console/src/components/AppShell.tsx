import { Outlet } from '@tanstack/react-router';
import type { CSSProperties } from 'react';
import { AppSidebar } from '@/components/AppSidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

/**
 * 登录后的应用外壳:侧边栏 + 页面内容。顶栏 2026-07-16 用户拍板删除:
 * 面包屑只是页面自带页头的第二份真相,⌘K 搜索入口随之移进侧栏
 * (CommandMenu),侧栏开关保留键盘位(⌘B,vendored sidebar 自带)。
 */
export function AppShell() {
  return (
    // 外壳锁定视口高度,滚动只发生在内容区(openasi 版式,2026-07-16):
    // 表格页因此能"表格占满剩余高度框内滚、分页钉底"。侧栏 15rem
    // (openasi 同宽;vendored sidebar.tsx 不动,用 CSS 变量覆写)。
    <SidebarProvider
      className="h-svh overflow-hidden"
      style={{ '--sidebar-width': '15rem' } as CSSProperties}
    >
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        {/* 页面自带容器(max-w/padding/gap 按页型),这里只给滚动口。 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
