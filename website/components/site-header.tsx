import Link from 'next/link';
import { DocsSearch, type SearchItem } from '@/components/docs-search';
import { ThemeToggle } from '@/components/theme-toggle';

export const GITHUB_URL = 'https://github.com/BitMiracle-AI/Dormice';

export function SiteHeader({ searchItems }: { searchItems: SearchItem[] }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="font-semibold">
          Dormice
        </Link>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link
            href="/docs"
            className="transition-colors hover:text-foreground"
          >
            Docs
          </Link>
          <a
            href={GITHUB_URL}
            className="transition-colors hover:text-foreground"
          >
            GitHub
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <DocsSearch items={searchItems} />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
