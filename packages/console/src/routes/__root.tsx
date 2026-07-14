import { createRootRoute, Outlet } from '@tanstack/react-router';
import { RootErrorBoundary } from '@/components/RootErrorBoundary';
import { Toaster } from '@/components/ui/sonner';

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <Toaster />
    </>
  ),
  // 漏网真异常(daemon 没起/500/渲染崩溃)的兜底,取代默认英文报错页。
  errorComponent: RootErrorBoundary,
});
