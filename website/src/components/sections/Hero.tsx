import Link from 'next/link';
import { InstallCommand } from '@/components/sections/InstallCommand';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GITHUB_URL } from '@/lib/site';
import { cn } from '@/lib/utils';

// The snippet from docs/e2b-sdks.mdx, verbatim. `changed` marks the only
// two lines that differ from stock E2B code — the highlight IS the pitch,
// so the rest of the code stays deliberately monochrome.
const migrationLines: { id: string; text: string; changed?: boolean }[] = [
  { id: 'import', text: "import { Sandbox } from 'e2b';" },
  { id: 'blank-1', text: '' },
  { id: 'create', text: 'const sbx = await Sandbox.create({' },
  {
    id: 'api-key',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: displayed source code, not an interpolation bug
    text: '  apiKey: `e2b_${process.env.DORMICE_API_TOKEN}`,',
  },
  {
    id: 'api-url',
    text: "  apiUrl: 'http://127.0.0.1:3676/e2b/api',",
    changed: true,
  },
  {
    id: 'sandbox-url',
    text: "  sandboxUrl: 'http://127.0.0.1:3676/e2b/envd',",
    changed: true,
  },
  { id: 'close', text: '});' },
  { id: 'blank-2', text: '' },
  { id: 'run', text: "await sbx.commands.run('echo hello');" },
];

export function Hero() {
  return (
    <section className="border-b">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-16 sm:py-20 lg:grid-cols-[1fr_minmax(0,30rem)] lg:gap-16 lg:py-24">
        <div className="flex min-w-0 flex-col items-start">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
              Self-hosted · Apache-2.0
            </span>
            <Badge variant="secondary">Early development</Badge>
          </div>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            The SQLite of agent sandboxes
          </h1>
          <p className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
            A sandbox platform for AI agents that runs on your own machine. One
            daemon, sandboxes that live forever, idle costs nothing.
          </p>
          <div className="mt-8 flex items-center gap-3">
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/docs/quickstart" />}
            >
              Get started
            </Button>
            <Button
              size="lg"
              variant="outline"
              nativeButton={false}
              render={<a href={GITHUB_URL} />}
            >
              GitHub
            </Button>
          </div>
          <InstallCommand className="mt-8" />
          <p className="mt-3 text-xs text-muted-foreground">
            Works end to end against real infrastructure, not production-ready
            yet.
          </p>
        </div>

        <figure className="w-full min-w-0">
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <span className="font-mono text-xs text-muted-foreground">
                agent.ts
              </span>
              <Badge variant="outline" className="font-mono text-[11px]">
                2 lines changed
              </Badge>
            </div>
            <pre className="overflow-x-auto py-4 font-mono text-[13px] leading-6">
              <code>
                {migrationLines.map((line) => (
                  <div
                    key={line.id}
                    className={cn(
                      'w-fit min-w-full whitespace-pre px-4',
                      line.changed &&
                        'border-l-2 border-primary bg-primary/10 pl-3.5',
                    )}
                  >
                    {line.text || ' '}
                  </div>
                ))}
              </code>
            </pre>
          </div>
          <figcaption className="mt-3 text-center text-xs text-muted-foreground">
            The official <code>e2b</code> SDK, unmodified — point two URLs at
            your own machine.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
