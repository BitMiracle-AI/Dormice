import { Outlet, useRouterState } from '@tanstack/react-router';
import { type CSSProperties, Fragment } from 'react';
import { AppSidebar } from '@/components/AppSidebar';
import { CommandMenu } from '@/components/CommandMenu';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';

// 路径段 → 中文名。没在表里的段(比如 name)原样展示 — 它就是名字本身。
const SEGMENT_LABELS: Record<string, string> = {
  sandboxes: '沙箱',
  templates: '模板',
  activity: '活动',
  'api-keys': 'API 密钥',
  domains: '域名',
  doctor: '体检',
  settings: '设置',
  version: '版本',
  connect: '连接',
};

function crumbsOf(pathname: string): string[] {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return ['仪表盘'];
  return segments.map(
    (segment) => SEGMENT_LABELS[segment] ?? decodeURIComponent(segment),
  );
}

/**
 * 登录后的应用外壳:侧边栏 + 顶栏(开关 + 面包屑)+ 页面内容。页面自己
 * 不再各画返回箭头和站名 — 导航是外壳的职责,页面只管自己的内容区。
 */
export function AppShell() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const crumbs = crumbsOf(pathname);

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
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          {/* 组件自带 data-vertical:self-stretch,限高后会钉在顶栏上沿 — 压回居中。 */}
          <Separator
            orientation="vertical"
            className="mr-2 !h-4 !self-center"
          />
          <Breadcrumb>
            <BreadcrumbList>
              {crumbs.map((crumb, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 面包屑是纯位置序列,段文本可重复
                <Fragment key={index}>
                  {index > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem>
                    <BreadcrumbPage
                      className={
                        index < crumbs.length - 1
                          ? 'font-normal text-muted-foreground'
                          : undefined
                      }
                    >
                      {crumb}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          <CommandMenu />
        </header>
        {/* 页面自带容器(max-w/padding/gap 按页型),这里只给滚动口。 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
