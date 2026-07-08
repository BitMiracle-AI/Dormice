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

  it('survives the cold cycle: idle -> frozen -> stopped -> re-acquire wakes it', async () => {
    const created = await client().acquireSandbox('sleeper-key', {
      freezeAfterSeconds: 1,
      stopAfterSeconds: 2,
      archiveAfterSeconds: null,
    });
    expect(created.sandbox.state).toBe('active');

    // The daemon sweeps every second: after ~1s idle the sandbox freezes,
    // after ~2s it stops. 3.5s of real time covers both plus scanner jitter.
    // The intermediate states are not observable from outside yet (that
    // needs a listSandboxes endpoint), but if freezing or waking is broken,
    // the re-acquire below fails loudly.
    await sleep(3.5);

    const woken = await client().acquireSandbox('sleeper-key');
    expect(woken.status).toBe('ready');
    expect(woken.sandbox.sandboxId).toBe(created.sandbox.sandboxId);
    expect(woken.sandbox.state).toBe('active');
  });
});
