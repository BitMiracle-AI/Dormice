import { createFileRoute } from '@tanstack/react-router';
import { SandboxDetailPage } from '@/features/sandboxes/pages/SandboxDetailPage';

// 工作台没有 tab,也就没有 search 参数(旧 ?tab= 链接被无害忽略)。
export const Route = createFileRoute('/_app/sandboxes/$name')({
  component: SandboxDetailPage,
});
