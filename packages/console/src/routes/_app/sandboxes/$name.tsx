import { createFileRoute } from '@tanstack/react-router';
import {
  DETAIL_TABS,
  type DetailTab,
  SandboxDetailPage,
} from '@/features/sandboxes/pages/SandboxDetailPage';

// tab 进 URL:刷新、分享、返回键都停在同一个工作区面板上。
export const Route = createFileRoute('/_app/sandboxes/$name')({
  validateSearch: (search: Record<string, unknown>): { tab: DetailTab } => ({
    tab: DETAIL_TABS.includes(search.tab as DetailTab)
      ? (search.tab as DetailTab)
      : 'overview',
  }),
  component: SandboxDetailPage,
});
