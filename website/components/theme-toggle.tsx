'use client';

import { Moon02Icon, Sun01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // The page is static: the server can't know the visitor's theme, so the
  // icon only becomes theme-dependent after mount (avoids hydration drift).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      <HugeiconsIcon icon={dark ? Sun01Icon : Moon02Icon} />
    </Button>
  );
}
