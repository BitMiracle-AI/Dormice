'use client';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import SearchDialog from '@/components/search';

// Client wrapper so the root layout (a server component) can hand
// RootProvider a component — the static search dialog.
export function Provider({ children }: { children: ReactNode }) {
  return <RootProvider search={{ SearchDialog }}>{children}</RootProvider>;
}
