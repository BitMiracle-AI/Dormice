import Link from 'next/link';
import { Button } from '@/components/ui/button';

// Static export writes this as out/404.html, which GitHub Pages and most
// static hosts serve for unknown paths automatically.
export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">
        The page you are looking for does not exist.
      </p>
      <div className="flex items-center gap-3">
        <Button nativeButton={false} render={<Link href="/" />}>
          Home
        </Button>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href="/docs" />}
        >
          Docs
        </Button>
      </div>
    </main>
  );
}
