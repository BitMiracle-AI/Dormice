import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { ThemeProvider } from '@/components/ThemeProvider';
import { docs } from '@/lib/docs';
import { SITE_DESCRIPTION, SITE_TITLE } from '@/lib/site';
import './global.css';

export const metadata: Metadata = {
  title: {
    default: SITE_TITLE,
    template: '%s | Dormice',
  },
  description: SITE_DESCRIPTION,
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
          <SiteFooter />
        </ThemeProvider>
      </body>
    </html>
  );
}
