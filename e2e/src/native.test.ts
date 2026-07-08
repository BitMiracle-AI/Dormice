import { DEFAULT_LIFECYCLE_POLICY, Dormice } from '@dormice/sdk';
import { describe, expect, inject, it } from 'vitest';

// One daemon serves the whole run, so every test uses its own user key to
// stay independent of the others.
function client(token = inject('dormiceToken')) {
  return new Dormice({ endpoint: inject('dormiceEndpoint'), token });
}

function sleep(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

describe('native API over a real daemon', () => {
  it('answers /healthz without a token', async () => {
    const res = await fetch(`${inject('dormiceEndpoint')}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects a wrong token with 401', async () => {
    const bad = client('w'.repeat(64));
    await expect(bad.acquireSandbox('auth-key')).rejects.toMatchObject({
      name: 'DormiceApiError',
      status: 401,
    });
  });

  it('acquires a fresh sandbox: ready, active, default policy', async () => {
    const res = await client().acquireSandbox('fresh-key');
    expect(res.status).toBe('ready');
    expect(res.sandbox.state).toBe('active');
    expect(res.sandbox.userKey).toBe('fresh-key');
    expect(res.sandbox.policy).toEqual(DEFAULT_LIFECYCLE_POLICY);
    expect(res.sandbox.endpoint).toBe(inject('dormiceEndpoint'));
  });

  it('is idempotent: the same key always returns the same sandbox', async () => {
    const first = await client().acquireSandbox('idem-key');
    const second = await client().acquireSandbox('idem-key');
    expect(second.sandbox.sandboxId).toBe(first.sandbox.sandboxId);
  });

  it('stores a policy override, including null for never-archive', async () => {
    const res = await client().acquireSandbox('override-key', {
      freezeAfterSeconds: 120,
      archiveAfterSeconds: null,
    });
    expect(res.sandbox.policy).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 120,
      archiveAfterSeconds: null,
    });
  });

  it('rejects a policy override that breaks the ordering rule', async () => {
    await expect(
      client().acquireSandbox('bad-policy-key', { archiveAfterSeconds: 1 }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/stopAfterSeconds/),
    });
  });

  it('rejects a malformed body with 400', async () => {
    await expect(
      // Bypass the SDK's types on purpose: a hand-written caller can send
      // anything, and the daemon must still answer with a clean 400.
      fetch(`${inject('dormiceEndpoint')}/acquireSandbox`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${inject('dormiceToken')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ policy: {} }),
      }).then((res) => res.status),
    ).resolves.toBe(400);
  });

  it('releases a sandbox: destroyed, forgotten, idempotent', async () => {
    const created = await client().acquireSandbox('release-key');

    expect(await client().releaseSandbox('release-key')).toEqual({
      released: true,
    });
    const listed = await client().listSandboxes();
    expect(listed.some((s) => s.sandboxId === created.sandbox.sandboxId)).toBe(
      false,
    );
    expect(await client().releaseSandbox('release-key')).toEqual({
      released: false,
    });

    // The key is free again: the next acquire builds a brand-new sandbox.
    const again = await client().acquireSandbox('release-key');
    expect(again.sandbox.sandboxId).not.toBe(created.sandbox.sandboxId);
  });

  it('survives the cold cycle: idle -> frozen -> stopped -> re-acquire wakes it', async () => {
    const created = await client().acquireSandbox('sleeper-key', {
      freezeAfterSeconds: 1,
      stopAfterSeconds: 2,
      archiveAfterSeconds: null,
    });
    expect(created.sandbox.state).toBe('active');

    // The daemon sweeps every second and cools one rung per sweep, so
    // stopped shows up in ~3s on an unloaded machine. Poll with a deadline
    // instead of napping a fixed time: a slow CI runner stretches the
    // schedule, and a fixed nap was half a second of margin from a flaky
    // red. Observed from outside throughout — the sandbox goes cold on its
    // own, in a separate process, on real wall-clock time.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const asleep = (await client().listSandboxes()).find(
        (s) => s.userKey === 'sleeper-key',
      );
      if (asleep?.state === 'stopped') break;
      if (Date.now() > deadline) {
        throw new Error(
          `sandbox never reached stopped; last observed: ${asleep?.state}`,
        );
      }
      await sleep(0.25);
    }

    const woken = await client().acquireSandbox('sleeper-key');
    expect(woken.status).toBe('ready');
    expect(woken.sandbox.sandboxId).toBe(created.sandbox.sandboxId);
    expect(woken.sandbox.state).toBe('active');
  });
});
