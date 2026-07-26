import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { ThemeProvider } from 'next-themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { queryClient } from '@/lib/queryClient';
import { m } from '@/paraglide/messages';
import { getLocale } from '@/paraglide/runtime';
import { routeTree } from './routeTree.gen';
import './index.css';

// index.html 里的 lang/title 是中文兜底(静态文件不知道 locale),
// JS 一挂载就按真实 locale 纠正 — 切换语言走 setLocale 整页刷新,
// 所以这里跑一次就够。
document.documentElement.lang = getLocale();
document.title = m.common_app_title();

// The daemon serves the console under /console; the router lives there too
// so server paths and client paths are the same strings everywhere.
const router = createRouter({ routeTree, basepath: '/console' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// biome-ignore lint/style/noNonNullAssertion: index.html always has #root
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 控制台恒定暗色(2026-07-16 用户拍板),forcedTheme 让 sonner 等
        useTheme 消费者拿到一致答案,不给亮色留后门。 */}
    <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
