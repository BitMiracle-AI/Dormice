'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

export interface DocsNavItem {
  href: string;
  title: string;
}

export interface DocsNavGroup {
  title: string;
  items: DocsNavItem[];
}

// Menu content only — it must live inside a <SidebarProvider> (the docs
// layout provides one; the mobile Sheet sits inside the same provider).
export function DocsSidebar({
  groups,
  onNavigate,
}: {
  groups: DocsNavGroup[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.title}>
          <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={pathname === item.href}
                    render={<Link href={item.href} onClick={onNavigate} />}
                  >
                    {item.title}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}
