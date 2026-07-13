import type { ReactNode } from 'react';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const features: { title: string; body: ReactNode }[] = [
  {
    title: 'Sandboxes are permanent',
    body: (
      <>
        <code>acquireSandbox(externalId)</code> is the entire mental model — the
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

export function Features() {
  return (
    <section className="mx-auto grid w-full max-w-4xl gap-4 px-4 pb-16 text-left sm:grid-cols-2 sm:pb-24">
      {features.map((feature) => (
        <Card key={feature.title}>
          <CardHeader>
            <CardTitle>{feature.title}</CardTitle>
            <CardDescription>{feature.body}</CardDescription>
          </CardHeader>
        </Card>
      ))}
    </section>
  );
}
