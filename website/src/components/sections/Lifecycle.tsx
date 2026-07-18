import Link from 'next/link';

// The four states and every number below come from docs/lifecycle.mdx —
// measured on real hardware, not aspirational. The ladder is a genuine
// sequence, so the left-to-right structure carries real information.
const stages = [
  {
    state: 'active',
    when: 'in use',
    body: 'The container is running, normally. Full RAM, full speed.',
    cost: 'full resources',
  },
  {
    state: 'frozen',
    when: 'after 10 min idle',
    body: 'Every process is suspended and its memory pushed out to swap — 1 GiB of sandbox memory drops to about 5 MiB.',
    cost: '~5 MiB RAM · wakes in ~50 ms',
  },
  {
    state: 'stopped',
    when: 'after 3 days',
    body: 'The container is shut down; only the disk remains. Waking is a cold start — files survive, processes do not.',
    cost: 'disk only · cold start in seconds',
  },
  {
    state: 'archived',
    when: 'after 7 days',
    body: 'The disk is compressed and shipped to your S3-compatible bucket; nothing remains on the host.',
    cost: 'S3 only · restores on acquire',
  },
];

export function Lifecycle() {
  return (
    <section className="border-b bg-muted/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:py-20">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Lifecycle
        </p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Idle sandboxes cool themselves down
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          The longer a sandbox sits idle, the colder — and cheaper — it gets,
          one step at a time. <code>acquireSandbox</code> brings it back from
          any state, files intact.
        </p>

        <div className="mt-10 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {stages.map((stage) => (
            <div key={stage.state} className="flex flex-col gap-3 bg-card p-5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-sm font-medium">
                  {stage.state}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {stage.when}
                </span>
              </div>
              <p className="flex-1 text-sm text-muted-foreground">
                {stage.body}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {stage.cost}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          Default thresholds shown — each one is a per-sandbox knob, and{' '}
          <code>null</code> means never.{' '}
          <Link
            href="/docs/lifecycle"
            className="underline underline-offset-4 transition-colors hover:text-foreground"
          >
            Read about the lifecycle
          </Link>
        </p>
      </div>
    </section>
  );
}
