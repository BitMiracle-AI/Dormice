import { Dormice } from '@dormice/sdk';
import { describe, expect, inject, it } from 'vitest';

// The archive lifecycle, black-box: the daemon runs against the exam's
// mini S3 (see setup/daemon.ts), so the whole cold path — idle down to
// archived, the disk gone from the host, then a poll-until-ready restore —
// runs over the real wire in every mode. Fake mode ships JSON archives,
// docker mode real tar.zst; the protocol is identical.

function client() {
  return new Dormice({
    endpoint: inject('dormiceEndpoint'),
    token: inject('dormiceToken'),
  });
}

function sleep(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

describe('the archive lifecycle over a real daemon', () => {
  it('archives by idleness, restores by acquire, data intact', async () => {
    const dormice = client();
    const first = await dormice.acquireSandbox('archive-key', {
      policy: {
        freezeAfterSeconds: 1,
        stopAfterSeconds: 2,
        archiveAfterSeconds: 3,
      },
    });
    const id = first.sandbox.sandboxId;
    await dormice.writeFiles('archive-key', [
      { path: 'kept.txt', content: 'survived the bucket' },
    ]);

    // Poll the observation window — never acquire, which would touch the
    // idle clock and keep the sandbox warm forever.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const sandboxes = await dormice.listSandboxes();
      const mine = sandboxes.find((s) => s.userKey === 'archive-key');
      if (mine?.state === 'archived') break;
      if (Date.now() > deadline) {
        throw new Error(`never archived; last observed: ${mine?.state}`);
      }
      await sleep(0.25);
    }

    // The re-acquire may answer `restoring` with progress or — the exam's
    // archives are tiny — already `ready`; either way polling acquire is
    // the documented way back, and the union is the wire contract.
    let outcome = await dormice.acquireSandbox('archive-key');
    const restoreDeadline = Date.now() + 15_000;
    while (outcome.status !== 'ready') {
      expect(outcome.status).toBe('restoring');
      if (outcome.status === 'restoring') {
        expect(['downloading', 'extracting']).toContain(outcome.progress.phase);
      }
      if (Date.now() > restoreDeadline) {
        throw new Error('restore never finished');
      }
      await sleep(0.25);
      outcome = await dormice.acquireSandbox('archive-key');
    }

    expect(outcome.sandbox.sandboxId).toBe(id);
    expect(outcome.sandbox.state).toBe('active');
    const read = await dormice.readFile('archive-key', 'kept.txt');
    expect(Buffer.from(read.content).toString()).toBe('survived the bucket');

    await dormice.releaseSandbox('archive-key');
  });

  it('a released archived sandbox is gone for good', async () => {
    const dormice = client();
    await dormice.acquireSandbox('archive-release-key', {
      policy: {
        freezeAfterSeconds: 1,
        stopAfterSeconds: 2,
        archiveAfterSeconds: 3,
      },
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const sandboxes = await dormice.listSandboxes();
      const mine = sandboxes.find((s) => s.userKey === 'archive-release-key');
      if (mine?.state === 'archived') break;
      if (Date.now() > deadline) {
        throw new Error(`never archived; last observed: ${mine?.state}`);
      }
      await sleep(0.25);
    }

    const released = await dormice.releaseSandbox('archive-release-key');
    expect(released.released).toBe(true);
    // The key is free again: the next acquire is a brand-new sandbox.
    const fresh = await dormice.acquireSandbox('archive-release-key');
    expect(fresh.status).toBe('ready');
    await dormice.releaseSandbox('archive-release-key');
  });
});
