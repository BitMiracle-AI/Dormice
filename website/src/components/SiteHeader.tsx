import { GithubIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import Link from 'next/link';
import { DocsSearch, type SearchItem } from '@/components/docs/DocsSearch';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { GITHUB_URL } from '@/lib/site';

export function SiteHeader({ searchItems }: { searchItems: SearchItem[] }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center px-4">
        <Link href="/" className="mr-4 font-semibold">
          Dormice
        </Link>
        <nav className="flex items-center">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            nativeButton={false}
            render={<Link href="/docs" />}
          >
            Docs
          </Button>
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <DocsSearch items={searchItems} />
          <Button
            variant="ghost"
            size="icon"
            nativeButton={false}
            render={<a href={GITHUB_URL} aria-label="GitHub" />}
          >
            <HugeiconsIcon icon={GithubIcon} />
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
