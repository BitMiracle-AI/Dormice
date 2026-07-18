import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '@/features/activity/pages/ActivityPage';

/**
 * 可选的 `?sandbox=`:沙箱工作台的「查看全部活动」带着名字跳过来,
 * 落地即预筛。只做一次性种子(灌进页内搜索框的初值),此后搜索框归
 * 用户 — 不做双向同步。
 */
export const Route = createFileRoute('/_app/activity')({
  validateSearch: (search: Record<string, unknown>): { sandbox?: string } =>
    typeof search.sandbox === 'string' && search.sandbox !== ''
      ? { sandbox: search.sandbox }
      : {},
  component: ActivityPage,
});
