import {
  ApiIcon,
  CloudUploadIcon,
  Database01Icon,
  Moon02Icon,
  RepeatIcon,
  Shield01Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';

// Every claim here is docs-backed (quickstart, lifecycle, architecture,
// e2b-sdks, archiving) — the landing page never outruns the docs.
const features: { icon: IconSvgElement; title: string; body: ReactNode }[] = [
  {
    icon: RepeatIcon,
    title: 'One name, one sandbox',
    body: (
      <>
        <code>acquireSandbox(name)</code> is the entire mental model — the same
        name always comes back to the same sandbox: created, woken, restarted or
        restored as needed.
      </>
    ),
  },
  {
    icon: Moon02Icon,
    title: 'Idle is free',
    body: (
      <>
        Sandboxes cool down on their own, one step at a time, and any acquire
        brings them back. Freeze, stop and archive thresholds are per-sandbox
        knobs — <code>null</code> means never.
      </>
    ),
  },
  {
    icon: Database01Icon,
    title: 'Deploys like a single binary',
    body: (
      <>
        One daemon, one SQLite ledger, one port. No Kubernetes, no external
        database — one install command on a bare Linux host.
      </>
    ),
  },
  {
    icon: ApiIcon,
    title: 'E2B compatible',
    body: (
      <>
        The official <code>e2b</code> SDKs — JavaScript and Python — run against
        Dormice unmodified: commands, files, PTY, signed URLs, watch, metrics.
      </>
    ),
  },
  {
    icon: Shield01Icon,
    title: 'gVisor isolation, no KVM',
    body: (
      <>
        Every sandbox runs behind gVisor&apos;s userspace kernel, so Dormice
        works on ordinary cloud VMs where hardware virtualization is not
        available.
      </>
    ),
  },
  {
    icon: CloudUploadIcon,
    title: 'Archives to S3',
    body: (
      <>
        Long-idle sandboxes compress into any S3-compatible bucket and restore
        on demand with real progress reporting — off unless you configure it.
      </>
    ),
  },
];

export function Features() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:py-20">
      <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
        Platform
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        One daemon, a full sandbox platform
      </h2>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Native API, the official E2B SDKs, a CLI and a web console — all talking
        to the same single process on your machine.
      </p>

      <div className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <div key={feature.title}>
            <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/50">
              <HugeiconsIcon
                icon={feature.icon}
                className="size-4.5 text-foreground"
              />
            </div>
            <h3 className="mt-4 font-medium">{feature.title}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{feature.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
