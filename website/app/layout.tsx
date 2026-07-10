import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Provider } from './provider';
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
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
