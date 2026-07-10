'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export interface DocsNavItem {
  href: string;
  title: string;
}

export function DocsSidebar({
  items,
  onNavigate,
}: {
  items: DocsNavItem[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={onNavigate}
          className={cn(
            'rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground',
            pathname === item.href &&
              'bg-accent font-medium text-accent-foreground',
          )}
        >
          {item.title}
        </Link>
      ))}
    </nav>
  );
}
