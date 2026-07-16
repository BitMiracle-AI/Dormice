import { createFileRoute, redirect } from '@tanstack/react-router';
import { TempGallery } from '@/components/TempGallery';

/**
 * 临时陈列页的挂架(RULES/前端.md「方案先行」):/temp/<日期>/<主题>/<方案>
 * 一条 splat 路由接住全部陈列页。陈列内容住在 gitignore 的
 * features/temp/ 里(公开仓历史 append-only,临时代码绝不入库),这里
 * 只有挂架入库 — routeTree.gen.ts 因此永远稳定,陈列页来去不碰它。
 */
export const Route = createFileRoute('/_app/temp/$')({
  beforeLoad: () => {
    // 陈列页是 dev 专属:生产构建里这条路由直接弹回首页。
    if (!import.meta.env.DEV) throw redirect({ to: '/' });
  },
  component: TempGallery,
});
