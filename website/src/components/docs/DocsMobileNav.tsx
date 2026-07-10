'use client';

import { useState } from 'react';
import { type DocsNavItem, DocsSidebar } from '@/components/docs/DocsSidebar';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

export function DocsMobileNav({ items }: { items: DocsNavItem[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        Menu
      </SheetTrigger>
      <SheetContent side="left">
        {/* The visible label comes from the menu's own group label. */}
        <SheetHeader className="sr-only">
          <SheetTitle>Documentation</SheetTitle>
        </SheetHeader>
        <div className="px-2">
          <DocsSidebar items={items} onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
