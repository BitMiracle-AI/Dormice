import { DEFAULT_LIFECYCLE_POLICY, Dormice } from '@dormice/sdk';
import { describe, expect, inject, it } from 'vitest';

// One daemon serves the whole run, so every test uses its own external id to
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
    expect(res.sandbox.externalId).toBe('fresh-key');
    // The exam daemon runs with S3 configured (see setup/daemon.ts), so the
    // archive default is live: a week from stopped to archived.
    expect(res.sandbox.policy).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      archiveAfterSeconds: 7 * 24 * 60 * 60,
    });
    expect(res.sandbox.endpoint).toBe(inject('dormiceEndpoint'));
  });

  it('is idempotent: the same key always returns the same sandbox', async () => {
    const first = await client().acquireSandbox('idem-key');
    const second = await client().acquireSandbox('idem-key');
    expect(second.sandbox.sandboxId).toBe(first.sandbox.sandboxId);
  });

  it('stores a policy override, including null for never-archive', async () => {
    const res = await client().acquireSandbox('override-key', {
      policy: { freezeAfterSeconds: 120, archiveAfterSeconds: null },
    });
    expect(res.sandbox.policy).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 120,
      archiveAfterSeconds: null,
    });
  });

  it('rejects a policy override that breaks the ordering rule', async () => {
    await expect(
      client().acquireSandbox('bad-policy-key', {
        policy: { archiveAfterSeconds: 1 },
      }),
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

  it('destroys a sandbox: gone, forgotten, idempotent', async () => {
    const created = await client().acquireSandbox('destroy-key');

    expect(await client().destroySandbox('destroy-key')).toEqual({
      destroyed: true,
    });
    const listed = await client().listSandboxes();
    expect(listed.some((s) => s.sandboxId === created.sandbox.sandboxId)).toBe(
      false,
    );
    expect(await client().destroySandbox('destroy-key')).toEqual({
      destroyed: false,
    });

    // The key is free again: the next acquire builds a brand-new sandbox.
    const again = await client().acquireSandbox('destroy-key');
    expect(again.sandbox.sandboxId).not.toBe(created.sandbox.sandboxId);
  });

  it('rebuilds a sandbox: shell swapped, /home/user kept, same key wakes it', async () => {
    const created = await client().acquireSandbox('rebuild-key');
    await client().writeFiles('rebuild-key', [
      { path: 'keep.txt', content: 'still here' },
    ]);

    const { sandbox } = await client().rebuildSandbox('rebuild-key');
    expect(sandbox.sandboxId).toBe(created.sandbox.sandboxId);
    expect(sandbox.state).toBe('stopped');

    // The wake after a rebuild is a cold start into a fresh container; the
    // disk — and with it the file — must have survived the swap.
    const again = await client().acquireSandbox('rebuild-key');
    expect(again.sandbox.sandboxId).toBe(created.sandbox.sandboxId);
    const read = await client().readFile('rebuild-key', 'keep.txt');
    expect(new TextDecoder().decode(read.content)).toBe('still here');

    await expect(client().rebuildSandbox('nobody-key')).rejects.toMatchObject({
      name: 'DormiceApiError',
      status: 404,
    });
    await client().destroySandbox('rebuild-key');
  });

  it('updates a lifecycle policy in place — no release, no lost disk', async () => {
    const created = await client().acquireSandbox('update-policy-key');

    // Promote to a never-stop resident agent; archive must fall with it
    // (only a stopped sandbox can archive) — sent together, as the console does.
    const { sandbox } = await client().updatePolicy('update-policy-key', {
      stopAfterSeconds: null,
      archiveAfterSeconds: null,
    });
    expect(sandbox.sandboxId).toBe(created.sandbox.sandboxId);
    expect(sandbox.policy.stopAfterSeconds).toBeNull();
    expect(sandbox.policy.archiveAfterSeconds).toBeNull();
    // Ledger-only: the sandbox itself was not woken or touched.
    expect(sandbox.state).toBe(created.sandbox.state);

    // The archive knob's front door works too on this S3-equipped daemon.
    const back = await client().updatePolicy('update-policy-key', {
      stopAfterSeconds: 3 * 24 * 60 * 60,
      archiveAfterSeconds: 30 * 24 * 60 * 60,
    });
    expect(back.sandbox.policy.archiveAfterSeconds).toBe(30 * 24 * 60 * 60);

    await expect(
      client().updatePolicy('update-policy-nobody', { freezeAfterSeconds: 60 }),
    ).rejects.toMatchObject({ name: 'DormiceApiError', status: 404 });
    await client().destroySandbox('update-policy-key');
  });

  // The fake's files hang off the disk, so only a real container can show
  // the other half of rebuild's promise: the container layer resets.
  it.runIf(process.env.DORMICE_EXECUTOR === 'docker')(
    'rebuild resets the container layer: /tmp evaporates, /home/user stays',
    async () => {
      await client().acquireSandbox('rebuild-layers-key');
      await client().execCommand(
        'rebuild-layers-key',
        'touch /tmp/ephemeral && echo kept > ~/kept.txt',
      );

      await client().rebuildSandbox('rebuild-layers-key');

      const check = await client().execCommand(
        'rebuild-layers-key',
        'ls /tmp/ephemeral; cat ~/kept.txt',
      );
      expect(check.stdout).toContain('kept');
      expect(check.stdout).not.toContain('ephemeral');
      expect(check.stderr).toMatch(/No such file/);
      await client().destroySandbox('rebuild-layers-key');
    },
  );

  it('runs a command in the sandbox and returns the buffered result', async () => {
    await client().acquireSandbox('exec-key');
    const result = await client().execCommand('exec-key', 'echo hi');
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    // A nonzero exit is a result, not an error.
    expect((await client().execCommand('exec-key', 'exit 3')).exitCode).toBe(3);
  });

  it('answers exec on an unknown key with 404, never a silent create', async () => {
    await expect(
      client().execCommand('exec-nobody-key', 'echo hi'),
    ).rejects.toMatchObject({
      name: 'DormiceApiError',
      status: 404,
      message: expect.stringMatching(/no sandbox for key/),
    });
  });

  it('a long-running command outlives the idle scanner: the heartbeat renews activity', async () => {
    // freeze:1 against the daemon's real 1s sweep: without the exec
    // heartbeat the scanner freezes the sandbox mid-sleep and the exec
    // dies against a paused container. Reverse-verified with the
    // heartbeat disabled.
    await client().acquireSandbox('exec-busy-key', {
      policy: {
        freezeAfterSeconds: 1,
        stopAfterSeconds: null,
        archiveAfterSeconds: null,
      },
    });
    const result = await client().execCommand('exec-busy-key', 'sleep 3');
    expect(result.exitCode).toBe(0);
    const observed = (await client().listSandboxes()).find(
      (s) => s.externalId === 'exec-busy-key',
    );
    expect(observed?.state).toBe('active');
  });

  it('exec wakes a frozen sandbox before running the command', async () => {
    await client().acquireSandbox('exec-wake-key', {
      policy: {
        freezeAfterSeconds: 1,
        stopAfterSeconds: null,
        archiveAfterSeconds: null,
      },
    });
    // Watch it actually freeze from outside, on real wall-clock time.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const cold = (await client().listSandboxes()).find(
        (s) => s.externalId === 'exec-wake-key',
      );
      if (cold?.state === 'frozen') break;
      if (Date.now() > deadline) {
        throw new Error(
          `sandbox never reached frozen; last observed: ${cold?.state}`,
        );
      }
      await sleep(0.25);
    }

    // A paused container cannot even receive an exec — the route must
    // wake it first, exactly like acquire does.
    const result = await client().execCommand('exec-wake-key', 'echo woke');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('woke\n');
    const observed = (await client().listSandboxes()).find(
      (s) => s.externalId === 'exec-wake-key',
    );
    expect(observed?.state).toBe('active');
  });

  it('survives the cold cycle: idle -> frozen -> stopped -> re-acquire wakes it', async () => {
    const created = await client().acquireSandbox('sleeper-key', {
      policy: {
        freezeAfterSeconds: 1,
        stopAfterSeconds: 2,
        archiveAfterSeconds: null,
      },
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
        (s) => s.externalId === 'sleeper-key',
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

  it('writes files in and reads them back byte-exact', async () => {
    await client().acquireSandbox('files-key');
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;

    const written = await client().writeFiles('files-key', [
      { path: 'hello.txt', content: 'hello from e2e\n' },
      // A nested relative path: parents are created, /home/user is the base.
      { path: 'nested/dir/blob.bin', content: bytes },
    ]);
    expect(written.files).toEqual([
      { path: '/home/user/hello.txt' },
      { path: '/home/user/nested/dir/blob.bin' },
    ]);

    const text = await client().readFile('files-key', '/home/user/hello.txt');
    expect(new TextDecoder().decode(text.content)).toBe('hello from e2e\n');
    const blob = await client().readFile('files-key', 'nested/dir/blob.bin');
    expect(blob.content).toEqual(bytes);
  });

  it('writeFile and readFiles: the single and batch forms hold the same contract', async () => {
    await client().acquireSandbox('files-key');
    await client().writeFiles('files-key', [
      { path: 'hello.txt', content: 'hello from e2e\n' },
    ]);

    const one = await client().writeFile(
      'files-key',
      'single.txt',
      'just me\n',
    );
    expect(one).toEqual({ path: '/home/user/single.txt' });

    // Batch read comes back in request order, paths resolved.
    const batch = await client().readFiles('files-key', [
      'single.txt',
      '/home/user/hello.txt',
    ]);
    expect(batch.map((f) => f.path)).toEqual([
      '/home/user/single.txt',
      '/home/user/hello.txt',
    ]);
    expect(batch.map((f) => new TextDecoder().decode(f.content))).toEqual([
      'just me\n',
      'hello from e2e\n',
    ]);

    // All or nothing: one missing path fails the whole batch, naming it.
    await expect(
      client().readFiles('files-key', ['single.txt', 'absent.txt']),
    ).rejects.toMatchObject({
      status: 404,
      message: 'no such file: /home/user/absent.txt',
    });
  });

  it('surfaces the honest errors: missing file 404, directory 400', async () => {
    await client().acquireSandbox('files-err-key');
    await expect(
      client().readFile('files-err-key', 'absent.txt'),
    ).rejects.toMatchObject({
      status: 404,
      message: 'no such file: /home/user/absent.txt',
    });
    await expect(
      client().readFile('files-err-key', '/home/user'),
    ).rejects.toMatchObject({
      status: 400,
      message: 'not a regular file: /home/user',
    });
  });

  it('templates: register, create from, removal guarded while in use', async () => {
    // In docker mode the image must actually exist — registration is only
    // config; the fake plays any name. The daemon's own base image serves
    // both: a real boot there, an arbitrary string here.
    const image = process.env.DORMICE_BASE_IMAGE ?? 'img:native';
    await client().registerTemplate('native-tpl', image);
    const created = await client().acquireSandbox('tpl-key', {
      template: 'native-tpl',
    });
    expect(created.sandbox.template).toBe('native-tpl');
    const listed = (await client().listSandboxes()).find(
      (s) => s.externalId === 'tpl-key',
    );
    expect(listed?.template).toBe('native-tpl');

    await expect(client().removeTemplate('native-tpl')).rejects.toMatchObject({
      name: 'DormiceApiError',
      status: 409,
      message: expect.stringMatching(/tpl-key/),
    });
    await client().destroySandbox('tpl-key');
    expect(await client().removeTemplate('native-tpl')).toEqual({
      removed: true,
    });
  });

  it('listSandboxImages tracks a template upgrade; rebuild closes the gap', async () => {
    // The daemon's base image doubles as the template image (real in docker
    // mode, an arbitrary string for the fake). The "upgrade" points the name
    // at an unbuilt image on purpose: registration is config and observation
    // never boots anything, so no engine ever has to pull it.
    const image = process.env.DORMICE_BASE_IMAGE ?? 'img:lineage-v1';
    await client().registerTemplate('lineage-tpl', image);
    const created = await client().acquireSandbox('lineage-key', {
      template: 'lineage-tpl',
    });
    const mine = async () =>
      (await client().listSandboxImages()).find(
        (e) => e.externalId === 'lineage-key',
      );

    // Fresh: born from the template's current image, nothing to upgrade.
    expect(await mine()).toEqual({
      externalId: 'lineage-key',
      sandboxId: created.sandbox.sandboxId,
      image,
      nextImage: image,
      upgradable: false,
    });

    // Re-registering moves nextImage; the live shell honestly stays behind.
    await client().registerTemplate('lineage-tpl', 'img:lineage-v2');
    expect(await mine()).toMatchObject({
      image,
      nextImage: 'img:lineage-v2',
      upgradable: true,
    });

    // Point the name back and rebuild: no shell means no image and nothing
    // to upgrade; the wake boots the template's current image, in sync.
    await client().registerTemplate('lineage-tpl', image);
    await client().rebuildSandbox('lineage-key');
    expect(await mine()).toMatchObject({
      image: null,
      nextImage: image,
      upgradable: false,
    });
    await client().acquireSandbox('lineage-key');
    expect(await mine()).toMatchObject({
      image,
      nextImage: image,
      upgradable: false,
    });

    await client().destroySandbox('lineage-key');
    expect(await client().removeTemplate('lineage-tpl')).toEqual({
      removed: true,
    });
  });

  // Registration never checks the image; only a real engine can show what
  // happens when the promise is broken at create time.
  it.runIf(process.env.DORMICE_EXECUTOR === 'docker')(
    'a template whose image is missing fails create with a named, honest error',
    async () => {
      await client().registerTemplate('hollow-tpl', 'img:does-not-exist');
      await expect(
        client().acquireSandbox('hollow-key', { template: 'hollow-tpl' }),
      ).rejects.toMatchObject({
        name: 'DormiceApiError',
        status: 500,
        message: expect.stringMatching(
          /image img:does-not-exist is not on this host/,
        ),
      });
      // Nothing was created: the key is still free, the template removable.
      expect(await client().destroySandbox('hollow-key')).toEqual({
        destroyed: false,
      });
      expect(await client().removeTemplate('hollow-tpl')).toEqual({
        removed: true,
      });
    },
  );

  it('reading a file wakes a frozen sandbox, and the file survived the cold', async () => {
    await client().acquireSandbox('files-wake-key', {
      policy: {
        freezeAfterSeconds: 1,
        stopAfterSeconds: null,
        archiveAfterSeconds: null,
      },
    });
    await client().writeFiles('files-wake-key', [
      { path: 'keep.txt', content: 'still here' },
    ]);
    // Watch it actually freeze from outside, on real wall-clock time.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const cold = (await client().listSandboxes()).find(
        (s) => s.externalId === 'files-wake-key',
      );
      if (cold?.state === 'frozen') break;
      if (Date.now() > deadline) {
        throw new Error(
          `sandbox never reached frozen; last observed: ${cold?.state}`,
        );
      }
      await sleep(0.25);
    }

    const read = await client().readFile('files-wake-key', 'keep.txt');
    expect(new TextDecoder().decode(read.content)).toBe('still here');
    const observed = (await client().listSandboxes()).find(
      (s) => s.externalId === 'files-wake-key',
    );
    expect(observed?.state).toBe('active');
  });

  it('reports host metrics: the machine and the fleet in one snapshot', async () => {
    await client().acquireSandbox('host-metrics-key');
    // The SDK already validates the response against the shared schema;
    // assertions stay >= because other test files share this daemon.
    const metrics = await client().getHostMetrics();
    expect(metrics.host.cpuCount).toBeGreaterThan(0);
    expect(metrics.host.memTotalBytes).toBeGreaterThan(0);
    expect(metrics.sandboxes.total).toBeGreaterThanOrEqual(1);
    expect(metrics.sandboxes.maxSandboxes).toBeGreaterThan(0);
    expect(metrics.sandboxDisks.count).toBeGreaterThanOrEqual(1);
    expect(metrics.sandboxDisks.actualBytes).toBeGreaterThan(0);
    // Disks are sparse: the fleet is promised more than it occupies —
    // the overcommit this window exists to watch.
    expect(metrics.sandboxDisks.nominalBytes).toBeGreaterThan(
      metrics.sandboxDisks.actualBytes,
    );
    await client().destroySandbox('host-metrics-key');
  });
});

describe('the observability verbs over a real daemon', () => {
  it('getConfig reports effective knobs and never leaks the token', async () => {
    const config = await client().getConfig();
    const token = config.entries.find((e) => e.key === 'DORMICE_API_TOKEN');
    expect(token).toMatchObject({ value: null, redacted: true });
    // Black-box secrecy: the real token appears nowhere in the response.
    expect(JSON.stringify(config)).not.toContain(inject('dormiceToken'));
    // The exam daemon runs with miniS3 configured, so the daemon's own
    // adjudication says archiving is live, with the one-week default.
    expect(config.archive).toEqual({
      enabled: true,
      defaultSeconds: 7 * 24 * 60 * 60,
    });
  });

  it('getSandboxMetrics samples a live sandbox and 404s after destroy', async () => {
    await client().acquireSandbox('obs-metrics-key');
    const sample = await client().getSandboxMetrics('obs-metrics-key');
    expect(sample).not.toBeNull();
    expect(sample?.memTotalBytes).toBeGreaterThan(0);
    expect(sample?.diskTotalBytes).toBeGreaterThan(0);

    await client().destroySandbox('obs-metrics-key');
    await expect(
      client().getSandboxMetrics('obs-metrics-key'),
    ).rejects.toMatchObject({ name: 'DormiceApiError', status: 404 });
  });

  it("listActivity tells one sandbox's story, newest first", async () => {
    await client().acquireSandbox('obs-story-key');
    await client().destroySandbox('obs-story-key');
    const events = await client().listActivity({ limit: 500 });
    const mine = events.filter((e) => e.externalId === 'obs-story-key');
    expect(mine.map((e) => e.kind)).toEqual(['destroyed', 'created']);
    expect(mine[1]?.detail).toContain('acquireSandbox');
  });
});
