import type { ReactNode } from 'react';
import { DocsMobileNav } from '@/components/docs/DocsMobileNav';
import { DocsSidebar } from '@/components/docs/DocsSidebar';
import {
  Sidebar,
  SidebarContent,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { docGroups } from '@/lib/docs';

export default function Layout({ children }: { children: ReactNode }) {
  const groups = docGroups.map((group) => ({
    title: group.title,
    items: group.entries.map((entry) => ({
      href: entry.href,
      title: entry.title,
    })),
  }));

  return (
    // The provider defaults to a full-viewport app shell (min-h-svh); this
    // page keeps the site header outside it, so those defaults are undone.
    <SidebarProvider className="mx-auto min-h-0 w-full max-w-6xl flex-1 items-start px-4">
      <Sidebar
        collapsible="none"
        className="sticky top-14 hidden h-[calc(100svh-3.5rem)] w-52 shrink-0 self-start border-r bg-transparent md:flex"
      >
        <SidebarContent className="py-4">
          <DocsSidebar groups={groups} />
        </SidebarContent>
      </Sidebar>
      <div className="min-w-0 flex-1 md:pl-8">
        <div className="border-b py-3 md:hidden">
          <DocsMobileNav groups={groups} />
        </div>
        {children}
      </div>
    </SidebarProvider>
  );
}
