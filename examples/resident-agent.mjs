// A resident agent: one sandbox per agent, kept forever. Run this file
// several times — the journal grows; nothing is ever re-created.
//
// `stopAfterSeconds: null` pins the sandbox to the top two rungs of the
// lifecycle: idle, it freezes (measured: ~1 GiB of resident memory squeezed
// to ~5 MiB) and any touch wakes it in ~50 ms — it never decays to a
// seconds-long cold start. Idle cost is a few MiB of swap and a sparse disk.
//
//   DORMICE_API_TOKEN=... node examples/resident-agent.mjs
import { Dormice } from '@dormice/sdk';

const endpoint = process.env.DORMICE_ENDPOINT ?? 'http://127.0.0.1:3676';
const token = process.env.DORMICE_API_TOKEN;
if (!token) {
  console.error(
    'Set DORMICE_API_TOKEN (it is in /etc/dormice/env on an install.sh host).',
  );
  process.exit(1);
}

const client = new Dormice({ endpoint, token });
const key = 'example-resident-agent';

// The policy applies when this acquire creates the sandbox; every later run
// just comes back to it.
const { sandbox } = await client.acquireSandbox(key, {
  policy: { stopAfterSeconds: null },
});
console.log(`${sandbox.id} — ${sandbox.state}, created ${sandbox.createdAt}`);

// State lives on the sandbox's disk, not in this script: every visit appends
// to the same journal.
const visit = await client.execCommand(
  key,
  'echo "$(date -u +%FT%TZ) visited" >> journal.txt && cat journal.txt',
);
console.log(visit.stdout.trimEnd());

// Deliberately NOT destroyed — a resident agent's sandbox outlives every run
// of this script. When you are done playing:
//   dor sandbox release example-resident-agent
console.log('\nleft running; the journal will still be here tomorrow.');
