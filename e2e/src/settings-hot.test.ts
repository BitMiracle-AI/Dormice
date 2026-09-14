import http from 'node:http';
import { Dormice } from '@dormice/sdk';
import { describe, expect, inject, it } from 'vitest';
import { door, listNodes, settled, until } from './helpers';

// The fleet-settings hot path for the two knobs that moved into the ledger
// on 2026-07-26 — the S3 archive store and the sandbox domain — as they
// travel since 2026-09-14: written at the gateway, carried to node A with
// its next check-in (settled() waits for that), acted on there. The exam's
// gateway and daemon are shared by every suite in this run, so each test
// here restores what it changed in a finally — and the S3 tests
// deliberately never move the shared store (rotating credentials against
// the same bucket, probing an unreachable endpoint, and exercising the
// refusal paths are all observation-safe; the full archive cycle over the
// shared store is archive.test.ts's exam).

/** The door: where settings are read and written. */
function client() {
  return new Dormice({ endpoint: door(), token: inject('dormiceToken') });
}

/** Node A, for what it does with the settings it was handed. */
function node() {
  return new Dormice({
    endpoint: inject('dormiceEndpoint'),
    token: inject('dormiceToken'),
  });
}

function sleep(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** A GET at the daemon with a spoofed Host header (fetch refuses to set Host). */
function throughProxy(
  host: string,
  path = '/',
): Promise<{ status: number; body: string }> {
  const endpoint = new URL(inject('dormiceEndpoint'));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: endpoint.hostname, port: endpoint.port, path, headers: { host } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('the S3 archive store as a live ledger setting', () => {
  it('reports the store keyless and accepts a probed credential rotation', async () => {
    const dormice = client();
    const config = await dormice.getConfig();
    const s3 = config.settings.s3;
    // The exam's gateway boots with the miniS3 env seed — the settings
    // view carries the four non-secret fields and nothing else.
    expect(s3).toMatchObject({ bucket: 'e2e-archive', forcePathStyle: true });
    // Black-box secrecy: neither key appears anywhere in the response.
    expect(JSON.stringify(config)).not.toContain('e2e-secret');

    // Same endpoint and bucket, re-typed keys: a rotation moves nothing,
    // so it passes the guard, and the gateway probes it against the real
    // miniS3 over the wire before saving.
    if (s3 === null) throw new Error('exam gateway lost its S3 seed');
    const { settings } = await dormice.updateSettings({
      s3: {
        endpoint: s3.endpoint,
        bucket: s3.bucket,
        region: s3.region,
        forcePathStyle: s3.forcePathStyle,
        accessKeyId: 'e2e-key',
        secretAccessKey: 'e2e-secret',
      },
    });
    expect(settings.s3?.bucket).toBe('e2e-archive');
    expect(JSON.stringify(settings)).not.toContain('e2e-secret');
    await settled();
  });

  it('refuses an unreachable store with S3’s own words and saves nothing', async () => {
    const dormice = client();
    const before = (await dormice.getConfig()).settings.s3;
    // Another endpoint is a move, and the moving-store guard is judged
    // before the probe: while another suite (archive.test.ts) has a
    // sandbox archived on the shared node, the answer is that guard's 400,
    // not the probe's 502 — so the attempt repeats until the fleet's
    // readings let the probe speak (seen in a local run, 2026-09-14).
    const refused = await until(async () => {
      try {
        await dormice.updateSettings({
          s3: {
            endpoint: 'http://127.0.0.1:1',
            bucket: 'nowhere',
            region: 'us-east-1',
            forcePathStyle: true,
            accessKeyId: 'k',
            secretAccessKey: 's',
          },
        });
        throw new Error('an unreachable store was accepted');
      } catch (error) {
        const { status, message } = error as {
          status?: number;
          message: string;
        };
        if (status === 400 && /archived or restoring/.test(message)) {
          return undefined;
        }
        return { status, message };
      }
    }, 12_000);
    expect(refused).toMatchObject({
      status: 502,
      message: expect.stringMatching(/nothing was saved/),
    });
    // The table did not move.
    expect((await dormice.getConfig()).settings.s3).toEqual(before);
  });

  it('refuses to clear or move the store while a sandbox is archived on a node — counted from the nodes’ check-ins', async () => {
    const dormice = client();
    // Park one of our own sandboxes in the archive so the guard has
    // something to protect, whatever the other suites are doing.
    await node().acquireSandbox('settings-hot-held', {
      policy: {
        freezeAfterSeconds: 1,
        stopAfterSeconds: 2,
        archiveAfterSeconds: 3,
      },
    });
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const mine = (await node().listSandboxes()).find(
          (s) => s.name === 'settings-hot-held',
        );
        if (mine?.state === 'archived') break;
        if (Date.now() > deadline) {
          throw new Error(`never archived; last observed: ${mine?.state}`);
        }
        await sleep(0.25);
      }
      // The gateway holds no sandbox state: it knows of the archived disk
      // from node A's next reading. Asking before that could clear the
      // store for real, so the reading is waited for first.
      await until(async () =>
        (await listNodes(door(), inject('dormiceToken'))).some(
          (n) => (n.reading?.sandboxes.byState.archived ?? 0) > 0,
        )
          ? true
          : undefined,
      );

      await expect(dormice.updateSettings({ s3: null })).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/archived or restoring/),
      });
      const current = (await dormice.getConfig()).settings.s3;
      if (current === null) throw new Error('exam gateway lost its S3 store');
      await expect(
        dormice.updateSettings({
          s3: {
            endpoint: current.endpoint,
            bucket: 'another-bucket',
            region: current.region,
            forcePathStyle: current.forcePathStyle,
            accessKeyId: 'e2e-key',
            secretAccessKey: 'e2e-secret',
          },
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/moving it to another/),
      });
      // Still the exam store, untouched.
      expect((await dormice.getConfig()).settings.s3?.bucket).toBe(
        'e2e-archive',
      );
    } finally {
      await node().destroySandbox('settings-hot-held');
    }
  });
});

describe('the sandbox domain as a live ledger setting', () => {
  it('a domain edit at the door engages and disengages node A’s proxy within a check-in, no restart', async () => {
    const dormice = client();
    const seeded = (await dormice.getConfig()).settings.sandboxDomain;
    expect(seeded).toBe('sbx.dormice.test');

    // A sandbox created before the switch: the proxy resolves by id, so
    // the same sandbox answers under whatever domain is in force.
    const { sandbox } = await node().acquireSandbox('settings-hot-domain');
    try {
      // The switch window is kept to three loopback round trips — the exam
      // daemon is shared, and other suites build hosts on the seed domain.
      const altHost = `8000-${sandbox.id}.alt.dormice.test`;
      const seededHost = `8000-${sandbox.id}.${seeded}`;
      // "Engaged" must hold in both worlds: the fake auto-answers behind
      // resolvePortTarget (200), a real sandbox has nothing on port 8000
      // and the proxy honestly answers 502 — either way the PROXY spoke.
      // Disengaged is Fastify's own router speaking: 404, in both worlds.
      const proxied = (status: number) => [200, 502].includes(status);
      await dormice.updateSettings({ sandboxDomain: 'alt.dormice.test' });
      try {
        await settled();
        const viaAlt = await throughProxy(altHost, '/hot?x=1');
        expect(viaAlt.status).toSatisfy(proxied);
        // The seed domain is out of force: its hosts are plain Fastify
        // traffic now, and the router answers 404, not the proxy.
        expect((await throughProxy(seededHost, '/hot')).status).toBe(404);
      } finally {
        await dormice.updateSettings({ sandboxDomain: seeded });
        await settled();
      }
      // Restored: the seed domain proxies again, the alt one is gone.
      expect((await throughProxy(seededHost, '/hot')).status).toSatisfy(
        proxied,
      );
      expect((await throughProxy(altHost, '/hot')).status).toBe(404);
    } finally {
      await node().destroySandbox('settings-hot-domain');
    }
  });

  it('aliases route inbound alongside the canonical domain, and the swap is atomic', async () => {
    const dormice = client();
    const seeded = (await dormice.getConfig()).settings.sandboxDomain;
    if (seeded === null) throw new Error('exam gateway lost its domain seed');
    expect((await dormice.getConfig()).settings.sandboxDomainAliases).toEqual(
      [],
    );

    const { sandbox } = await node().acquireSandbox('settings-hot-alias');
    const aliasHost = `8000-${sandbox.id}.alias.dormice.test`;
    const seededHost = `8000-${sandbox.id}.${seeded}`;
    const proxied = (status: number) => [200, 502].includes(status);
    try {
      // An alias joins the group: both hosts reach the proxy, the seed
      // domain keeps its place as the canonical one.
      await dormice.updateSettings({
        sandboxDomainAliases: ['alias.dormice.test'],
      });
      await settled();
      expect((await throughProxy(aliasHost, '/hot')).status).toSatisfy(proxied);
      expect((await throughProxy(seededHost, '/hot')).status).toSatisfy(
        proxied,
      );

      // The atomic swap: alias up, old canonical into the alias list —
      // one patch, and both hosts keep routing through it.
      const { settings } = await dormice.updateSettings({
        sandboxDomain: 'alias.dormice.test',
        sandboxDomainAliases: [seeded],
      });
      expect(settings.sandboxDomain).toBe('alias.dormice.test');
      expect(settings.sandboxDomainAliases).toEqual([seeded]);
      await settled();
      expect((await throughProxy(aliasHost, '/hot')).status).toSatisfy(proxied);
      expect((await throughProxy(seededHost, '/hot')).status).toSatisfy(
        proxied,
      );
    } finally {
      // Both fields back: restoring the canonical alone would leave the
      // alias standing (and the swap case would even trip the overlap
      // guard), on a daemon every suite shares.
      await dormice.updateSettings({
        sandboxDomain: seeded,
        sandboxDomainAliases: [],
      });
      await settled();
      await node().destroySandbox('settings-hot-alias');
    }
  });
});
