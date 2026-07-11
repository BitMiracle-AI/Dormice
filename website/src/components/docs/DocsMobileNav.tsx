'use client';

import { useState } from 'react';
import { type DocsNavGroup, DocsSidebar } from '@/components/docs/DocsSidebar';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

export function DocsMobileNav({ groups }: { groups: DocsNavGroup[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        Menu
      </SheetTrigger>
      <SheetContent side="left">
        {/* The visible labels come from the menu's own group labels. */}
        <SheetHeader className="sr-only">
          <SheetTitle>Documentation</SheetTitle>
        </SheetHeader>
        <div className="overflow-y-auto px-2">
          <DocsSidebar groups={groups} onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
