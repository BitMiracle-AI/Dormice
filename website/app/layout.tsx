import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/site-header';
import { ThemeProvider } from '@/components/theme-provider';
import { docs } from '@/lib/docs';
import './global.css';

export const metadata: Metadata = {
  title: {
    default: 'Dormice — the SQLite of agent sandboxes',
    template: '%s | Dormice',
  },
  description:
    'A self-hosted sandbox platform for AI agents. One machine, sandboxes that live forever, idle costs nothing.',
};

export default function Layout({ children }: { children: ReactNode }) {
  const searchItems = docs.map(({ href, title, description }) => ({
    href,
    title,
    description,
  }));

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col antialiased">
        <ThemeProvider>
          <SiteHeader searchItems={searchItems} />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
