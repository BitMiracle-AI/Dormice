import { useParams } from '@tanstack/react-router';
import { type ComponentType, useEffect, useState } from 'react';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';

/**
 * 临时陈列页的装载器(RULES/前端.md「方案先行」)。陈列内容不入库
 * (.gitignore 的 temp/ 规则:公开仓历史 append-only,临时代码一次误
 * 提交就永久留在历史里),所以不能走文件路由 — routeTree.gen.ts 是
 * 入库文件,引用被忽略的路由文件会在 CI 上断链。这里用 import.meta.glob
 * 在构建期收集本机存在的陈列主题:CI 与生产构建里 temp/ 为空,glob
 * 自然是空表,挂架无害地长驻。
 *
 * 约定:features/temp/<日期>/<主题>/index.tsx 导出
 * `TEMP_PAGES: Record<方案键, 组件>`,URL 即 /temp/<日期>/<主题>/<方案键>。
 */
const TOPICS = import.meta.glob('/src/features/temp/*/*/index.tsx');

type TempPages = Record<string, ComponentType>;

export function TempGallery() {
  const { _splat } = useParams({ from: '/_app/temp/$' });
  const [date, topic, page] = (_splat ?? '').split('/');
  const loader = TOPICS[`/src/features/temp/${date}/${topic}/index.tsx`];

  const [pages, setPages] = useState<TempPages | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setMissing(false);
    if (!loader) {
      setMissing(true);
      return;
    }
    void loader().then((mod) => {
      if (cancelled) return;
      const exported = (mod as { TEMP_PAGES?: TempPages }).TEMP_PAGES;
      if (exported) setPages(exported);
      else setMissing(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loader]);

  const Page = pages?.[page ?? ''];

  if (missing || (pages && !Page)) {
    return (
      <Empty className="m-6 border border-dashed">
        <EmptyHeader>
          <EmptyTitle>没有这个陈列页</EmptyTitle>
          <EmptyDescription>
            陈列页住在 features/temp/&lt;日期&gt;/&lt;主题&gt;/,不入库也不进
            生产 — 它可能已经拍板删除了。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (!Page) {
    return (
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  }
  return <Page />;
}
