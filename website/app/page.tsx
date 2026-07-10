import Link from 'next/link';
import { GITHUB_URL } from '@/components/site-header';
import { Button } from '@/components/ui/button';

const features = [
  {
    title: 'Sandboxes are permanent',
    body: (
      <>
        <code>acquireSandbox(userKey)</code> is the entire mental model — the
        same key always comes back to the same sandbox: created, woken or
        restarted as needed.
      </>
    ),
  },
  {
    title: 'Idle is free',
    body: (
      <>
        Sandboxes cool down on their own, one rung at a time. Measured on real
        hardware: 1 GiB of sandbox memory freezes down to ~5 MiB, and waking
        takes ~50 ms — with every process still running.
      </>
    ),
  },
  {
    title: 'Deploys like a single binary',
    body: (
      <>
        One daemon, one SQLite ledger, one port. No Kubernetes, no external
        database — one install command on a bare Linux host.
      </>
    ),
  },
  {
    title: 'E2B compatible',
    body: (
      <>
        The official <code>e2b</code> SDK runs against Dormice by changing two
        URLs — commands, files, PTY, signed URLs, watch, metrics.
      </>
    ),
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-16 text-center sm:py-24">
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
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
        Early development: works end to end against real infrastructure, not
        production-ready yet.
      </p>
      <pre className="mt-10 max-w-full overflow-x-auto rounded-lg border bg-card px-5 py-4 text-left text-sm">
        <code>
          curl -fsSL
          https://raw.githubusercontent.com/BitMiracle-AI/Dormice/main/deploy/install.sh
          | bash
        </code>
      </pre>
      <div className="mt-16 grid w-full max-w-4xl gap-4 text-left sm:grid-cols-2">
        {features.map((feature) => (
          <div key={feature.title} className="rounded-lg border bg-card p-6">
            <h2 className="font-medium">{feature.title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{feature.body}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
