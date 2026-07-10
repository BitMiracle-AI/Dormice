import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GITHUB_URL } from '@/lib/site';

export function Hero() {
  return (
    <section className="flex flex-col items-center px-4 py-16 text-center sm:py-24">
      <Badge variant="secondary">Early development</Badge>
      <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        The SQLite of agent sandboxes
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
        A self-hosted sandbox platform for AI agents. One machine, sandboxes
        that live forever, idle costs nothing.
      </p>
      <div className="mt-8 flex items-center gap-3">
        <Button size="lg" render={<Link href="/docs" />}>
          Get started
        </Button>
        <Button size="lg" variant="outline" render={<a href={GITHUB_URL} />}>
          GitHub
        </Button>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Works end to end against real infrastructure, not production-ready yet.
      </p>
      <pre className="mt-10 max-w-full overflow-x-auto rounded-lg border bg-card px-5 py-4 text-left text-sm">
        <code>
          curl -fsSL
          https://raw.githubusercontent.com/BitMiracle-AI/Dormice/main/deploy/install.sh
          | bash
        </code>
      </pre>
    </section>
  );
}
