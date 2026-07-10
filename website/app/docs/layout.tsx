import type { ReactNode } from 'react';
import { DocsMobileNav } from '@/components/docs-mobile-nav';
import { DocsSidebar } from '@/components/docs-sidebar';
import { docs } from '@/lib/docs';

export default function Layout({ children }: { children: ReactNode }) {
  const items = docs.map(({ href, title }) => ({ href, title }));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 items-start px-4">
      <aside className="sticky top-14 hidden max-h-[calc(100vh-3.5rem)] w-52 shrink-0 overflow-y-auto border-r py-8 pr-4 md:block">
        <DocsSidebar items={items} />
      </aside>
      <div className="min-w-0 flex-1 md:pl-8">
        <div className="border-b py-3 md:hidden">
          <DocsMobileNav items={items} />
        </div>
        {children}
      </div>
    </div>
  );
}
