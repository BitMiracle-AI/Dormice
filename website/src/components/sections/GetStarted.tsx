import Link from 'next/link';
import { InstallCommand } from '@/components/sections/InstallCommand';
import { Button } from '@/components/ui/button';
import { GITHUB_URL } from '@/lib/site';

// Closing restatement of the hero's call to action: by the time a reader
// is here they've seen the pitch, so this section is just the door.
export function GetStarted() {
  return (
    <section className="border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-4 py-16 text-center sm:py-20">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Self-host it in one command
        </h2>
        <p className="mt-3 max-w-xl text-muted-foreground">
          The installer sets up Docker, gVisor and the daemon on a bare Linux
          host, and running it again upgrades in place.
        </p>
        <InstallCommand className="mt-8" />
        <div className="mt-8 flex items-center gap-3">
          <Button
            size="lg"
            nativeButton={false}
            render={<Link href="/docs/quickstart" />}
          >
            Read the quickstart
          </Button>
          <Button
            size="lg"
            variant="outline"
            nativeButton={false}
            render={<a href={GITHUB_URL} />}
          >
            Star on GitHub
          </Button>
        </div>
      </div>
    </section>
  );
}
