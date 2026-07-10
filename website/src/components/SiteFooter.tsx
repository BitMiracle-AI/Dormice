import { GITHUB_URL } from '@/lib/site';

export function SiteFooter() {
  return (
    <footer className="border-t py-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 text-xs text-muted-foreground sm:flex-row">
        <p>
          Apache-2.0. E2B is a trademark of its owner; Dormice is not affiliated
          with or endorsed by E2B.
        </p>
        <a
          href={GITHUB_URL}
          className="transition-colors hover:text-foreground"
        >
          GitHub
        </a>
      </div>
    </footer>
  );
}
