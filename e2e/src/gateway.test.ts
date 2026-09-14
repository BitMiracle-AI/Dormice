import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dormice } from '@dormice/sdk';
import { Sandbox } from 'e2b';
import { describe, expect, inject, it } from 'vitest';
import {
  configSettled,
  listNodes as listFleetNodes,
  rpc as post,
  spoofHost,
  until,
} from './helpers';

// The fleet exam: two real daemons behind a real gateway, all three booted
// the production way and driven only over the wire — the SDK, the
// official e2b package and plain fetch. Direct calls to a node exist only
// to stage what the gateway must then find (a sandbox built behind its
// back, a name on two nodes, a destroy it did not see). Skipped in docker
// mode, where the setup boots node A (and its own gateway) alone.
const skip = inject('dormiceFleetNodes') === null;

const gateway = () => inject('dormiceFleetGateway') as string;
const token = () => inject('dormiceFleetToken') as string;
const nodes = () =>
  inject('dormiceFleetNodes') as Array<{ id: string; endpoint: string }>;
const viaGateway = () => new Dormice({ endpoint: gateway(), token: token() });
function direct(id: string) {
  const node = nodes().find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id} in the exam fleet`);
  return new Dormice({ endpoint: node.endpoint, token: token() });
}
const other = (id: string) => (id === 'node-b' ? 'node-c' : 'node-b');

const rpc = (
  path: string,
  payload: unknown = {},
  bearer = token(),
  endpoint = gateway(),
) => post(endpoint, path, payload, bearer);

const listNodes = () => listFleetNodes(gateway(), token());

const status = (error: unknown) => (error as { status?: number }).status;
const message = (r: { body: unknown }) =>
  (r.body as { message: string }).message;

describe.skipIf(skip)('the gateway in front of two daemons', () => {
  it('/healthz is open and names the build; a wrong token is refused', async () => {
    const health = (await (await fetch(`${gateway()}/healthz`)).json()) as {
      status: string;
      build: { commit: string } | null;
    };
    expect(health.status).toBe('ok');
    expect(health.build?.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect((await rpc('/listNodes', {}, 'x'.repeat(64))).status).toBe(401);
  });

  it('both nodes checked in: reachable, with a reading, the build they run and the configuration version they took from this gateway', async () => {
    const listed = await until(async () => {
      const seen = await listNodes();
      return seen.length === 2 && seen.every((n) => n.reachable)
        ? seen
        : undefined;
    });
    expect(listed.map((n) => n.id).sort()).toEqual(['node-b', 'node-c']);
    const { body } = await rpc('/getConfig');
    const version = (body as { configVersion: number }).configVersion;
    for (const node of listed) {
      expect(node.reading?.sandboxes.byState.active).toBeGreaterThanOrEqual(0);
      expect(node.build?.commit).toMatch(/^[0-9a-f]{7,}$/);
      expect(node.endpoint).toBe(
        nodes().find((n) => n.id === node.id)?.endpoint,
      );
      // A node boots on the gateway's bundle and reports its version back.
      expect(node.configVersion).toBe(version);
    }
  });

  it("a settings write at the gateway reaches both nodes within their check-in: the copy's defaults shape the next acquire", async () => {
    const before = (await rpc('/getConfig')).body as {
      configVersion: number;
      settings: {
        sandboxDefaults: { cpus: number; memoryGb: number; diskGb: number };
      };
    };
    const { status } = await rpc('/updateSettings', {
      sandboxDefaults: { ...before.settings.sandboxDefaults, cpus: 3 },
    });
    expect(status).toBe(200);
    try {
      const version = await configSettled(gateway(), token());
      expect(version).toBe(before.configVersion + 1);
      // Asked of the node directly: its own copy answers, no gateway in the path.
      const created = await direct('node-b').acquireSandbox('gw-config');
      try {
        expect(created.sandbox.spec.cpus).toBe(3);
      } finally {
        await direct('node-b').destroySandbox('gw-config');
      }
    } finally {
      await rpc('/updateSettings', {
        sandboxDefaults: before.settings.sandboxDefaults,
      });
      await configSettled(gateway(), token());
    }
  });

  it('a template registered at the gateway is usable on every node; removal asks the nodes and is refused while one holds a sandbox on it', async () => {
    await viaGateway().registerTemplate('gw-tpl', 'img:gw-tpl');
    await configSettled(gateway(), token());
    const staged = await direct('node-b').acquireSandbox('gw-tpl-user', {
      template: 'gw-tpl',
    });
    try {
      expect(staged.sandbox.template).toBe('gw-tpl');
      await expect(viaGateway().removeTemplate('gw-tpl')).rejects.toMatchObject(
        {
          status: 409,
          message: expect.stringMatching(/gw-tpl-user on node node-b/),
        },
      );
    } finally {
      await direct('node-b').destroySandbox('gw-tpl-user');
    }
    expect(await viaGateway().removeTemplate('gw-tpl')).toEqual({
      removed: true,
    });
    await configSettled(gateway(), token());
    // Gone from the nodes' copies too: an acquire on it is the node's own 400.
    await expect(
      direct('node-c').acquireSandbox('gw-tpl-late', { template: 'gw-tpl' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('envdToken through the gateway is minted by the sandbox’s node and opens its envd surface through the gateway', async () => {
    const created = await viaGateway().acquireSandbox('gw-envd');
    try {
      const minted = await rpc('/envdToken', { sandboxId: created.sandbox.id });
      expect(minted.status).toBe(200);
      const { envdAccessToken } = minted.body as { envdAccessToken: string };
      const stat = await fetch(
        `${gateway()}/e2b/envd/filesystem.Filesystem/Stat`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'e2b-sandbox-id': created.sandbox.id,
            'x-access-token': envdAccessToken,
          },
          body: JSON.stringify({ path: '/home/user' }),
        },
      );
      expect(stat.status).toBe(200);
      // Per sandbox: the same token opens no other.
      const stranger = await fetch(
        `${gateway()}/e2b/envd/filesystem.Filesystem/Stat`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'e2b-sandbox-id': randomUUID(),
            'x-access-token': envdAccessToken,
          },
          body: JSON.stringify({ path: '/home/user' }),
        },
      );
      expect(stat.status).toBe(200);
      expect(stranger.status).not.toBe(200);
    } finally {
      await viaGateway().destroySandbox('gw-envd');
    }
  });

  it('a sandbox host at the fleet door reaches the node holding the sandbox — getHost() through the gateway, over HTTP and a WebSocket upgrade; an id on no node is the proxy’s own 502', async () => {
    const created = await viaGateway().acquireSandbox('gw-host');
    try {
      const id = created.sandbox.id;
      const host = `8000-${id}.sbx.dormice.test`;
      // The fake executor's upstream echoes what reached the sandbox: the
      // id proves which sandbox answered, the host that the Host was kept.
      const res = await spoofHost(gateway(), host, '/hello?via=door');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        sandboxId: id,
        path: '/hello?via=door',
        host,
      });
      // The node that does not hold it says so directly — the door asked
      // the right one.
      const elsewhere = await spoofHost(
        nodes().find((n) => n.id !== created.sandbox.nodeId)?.endpoint ?? '',
        host,
        '/',
      );
      expect(elsewhere.status).toBe(502);
      expect(JSON.parse(elsewhere.body).message).toContain('not found');

      // The upgrade half: a raw handshake through the door, the echo back.
      const url = new URL(gateway());
      const echoed = await new Promise<string>((resolve, reject) => {
        let buffer = '';
        const socket = net.connect(Number(url.port), url.hostname, () => {
          socket.write(
            [
              'GET /ws HTTP/1.1',
              `Host: 5173-${id}.sbx.dormice.test`,
              'Connection: Upgrade',
              'Upgrade: websocket',
              '',
              '',
            ].join('\r\n'),
          );
        });
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (buffer.includes(' 101 ') && !buffer.includes('marco')) {
            socket.write('marco');
          }
          if (buffer.includes('marco')) socket.end();
        });
        socket.on('close', () => resolve(buffer));
        socket.on('error', reject);
        setTimeout(() => reject(new Error('upgrade timed out')), 5_000);
      });
      expect(echoed).toContain(' 101 ');
      expect(echoed).toContain('marco');

      const nobody = await spoofHost(
        gateway(),
        `8000-${randomUUID()}.sbx.dormice.test`,
        '/',
      );
      expect(nobody.status).toBe(502);
      expect(JSON.parse(nobody.body).message).toMatch(/on no node/);
    } finally {
      await viaGateway().destroySandbox('gw-host');
    }
  });

  it('acquire is placed on one node and lands in exactly one ledger; re-acquire finds it there', async () => {
    const created = await viaGateway().acquireSandbox('gw-place');
    try {
      expect(created.status).toBe('ready');
      expect(created.created).toBe(true);
      expect(['node-b', 'node-c']).toContain(created.sandbox.nodeId);
      const here = await direct(created.sandbox.nodeId).listSandboxes();
      expect(here.sandboxes.some((s) => s.id === created.sandbox.id)).toBe(
        true,
      );
      const there = await direct(other(created.sandbox.nodeId)).listSandboxes();
      expect(there.sandboxes.some((s) => s.name === 'gw-place')).toBe(false);

      const again = await viaGateway().acquireSandbox('gw-place');
      expect(again.created).toBe(false);
      expect(again.sandbox.id).toBe(created.sandbox.id);
      expect(again.sandbox.nodeId).toBe(created.sandbox.nodeId);
    } finally {
      await viaGateway().destroySandbox('gw-place');
    }
  });

  it("files and commands round-trip; a node's 404 for a missing file passes through and the sandbox stays routable", async () => {
    await viaGateway().acquireSandbox('gw-work');
    try {
      await viaGateway().writeFile('gw-work', 'hello.txt', 'via gateway');
      const read = await viaGateway().readFile('gw-work', 'hello.txt');
      expect(new TextDecoder().decode(read.content)).toBe('via gateway');
      const ran = await viaGateway().execCommand('gw-work', 'echo through');
      expect(ran.stdout).toBe('through\n');

      await expect(
        viaGateway().readFile('gw-work', 'missing.txt'),
      ).rejects.toMatchObject({ name: 'DormiceApiError', status: 404 });
      expect(
        (await viaGateway().execCommand('gw-work', 'echo still-here')).stdout,
      ).toBe('still-here\n');
    } finally {
      await viaGateway().destroySandbox('gw-work');
    }
  });

  it('five simultaneous acquires of a new name are one sandbox on one node', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => viaGateway().acquireSandbox('gw-burst')),
    );
    try {
      expect(new Set(results.map((r) => r.sandbox.id)).size).toBe(1);
      expect(new Set(results.map((r) => r.sandbox.nodeId)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    } finally {
      await viaGateway().destroySandbox('gw-burst');
    }
  });

  it('a sandbox built behind its back is found by asking — at once, no reconcile to wait for', async () => {
    const staged = await direct('node-b').acquireSandbox('gw-staged');
    try {
      const ran = await viaGateway().execCommand('gw-staged', 'echo found');
      expect(ran.stdout).toBe('found\n');
      const found = await viaGateway().acquireSandbox('gw-staged');
      expect(found.created).toBe(false);
      expect(found.sandbox.id).toBe(staged.sandbox.id);
      expect(found.sandbox.nodeId).toBe('node-b');
    } finally {
      await viaGateway().destroySandbox('gw-staged');
    }
  });

  it('one name on two nodes is refused with a 409 naming both, and routable again once one copy is destroyed', async () => {
    await direct('node-b').acquireSandbox('gw-twin');
    await direct('node-c').acquireSandbox('gw-twin');
    try {
      await expect(
        viaGateway().acquireSandbox('gw-twin'),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/node-b and node-c/),
      });
      await expect(
        viaGateway().execCommand('gw-twin', 'true'),
      ).rejects.toMatchObject({ status: 409 });
      await direct('node-c').destroySandbox('gw-twin');
      const healed = await viaGateway().acquireSandbox('gw-twin');
      expect(healed.created).toBe(false);
      expect(healed.sandbox.nodeId).toBe('node-b');
    } finally {
      await direct('node-b').destroySandbox('gw-twin');
      await direct('node-c').destroySandbox('gw-twin');
    }
  });

  it('a destroy through the gateway is final; a destroy behind its back is caught on the next use and the name is asked for afresh', async () => {
    const created = await viaGateway().acquireSandbox('gw-gone');
    expect(await viaGateway().destroySandbox('gw-gone')).toEqual({
      destroyed: true,
    });
    await expect(
      viaGateway().execCommand('gw-gone', 'true'),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/no sandbox named "gw-gone"/),
    });
    expect(await viaGateway().destroySandbox('gw-gone')).toEqual({
      destroyed: false,
    });
    const reborn = await viaGateway().acquireSandbox('gw-gone');
    expect(reborn.created).toBe(true);
    expect(reborn.sandbox.id).not.toBe(created.sandbox.id);
    try {
      // Destroyed directly on its node, then rebuilt directly on the other:
      // the gateway's first use relays the node's own 404, re-checks the
      // cache off the request path, and the next use finds the new home.
      // Without the re-check every use would keep going to the old node.
      await direct(reborn.sandbox.nodeId).destroySandbox('gw-gone');
      await expect(
        viaGateway().execCommand('gw-gone', 'true'),
      ).rejects.toMatchObject({ status: 404 });
      const moved = await direct(other(reborn.sandbox.nodeId)).acquireSandbox(
        'gw-gone',
      );
      await until(async () => {
        try {
          return await viaGateway().execCommand('gw-gone', 'echo moved');
        } catch (error) {
          if (status(error) === 404) return undefined;
          throw error;
        }
      });
      const found = await viaGateway().acquireSandbox('gw-gone');
      expect(found.created).toBe(false);
      expect(found.sandbox.id).toBe(moved.sandbox.id);
    } finally {
      await viaGateway().destroySandbox('gw-gone');
    }
  });

  it('the active gate (2 per node here) refuses with a 503 naming every node, and reopens when a sandbox is destroyed', async () => {
    const baseline = new Map(
      (await listNodes()).map((n) => [
        n.id,
        n.reading?.sandboxes.byState.active ?? 0,
      ]),
    );
    const names: string[] = [];
    try {
      const refusal = await until(async () => {
        if (names.length > 8) throw new Error('gate never closed');
        const name = `gw-fill-${names.length}`;
        const answer = await rpc('/acquireSandbox', { name });
        if (answer.status === 200) {
          names.push(name);
          return undefined;
        }
        return answer.status === 503 ? answer : undefined;
      }, 20_000);
      expect(message(refusal)).toContain('node-b');
      expect(message(refusal)).toContain('node-c');
      expect(message(refusal)).toContain('reach the 2 limit');
      expect(refusal.headers.get('retry-after')).toBe('15');

      const freed = names.pop();
      if (freed) await viaGateway().destroySandbox(freed);
      const reopened = await until(async () => {
        try {
          return await viaGateway().acquireSandbox('gw-fill-late');
        } catch (error) {
          if (status(error) === 503) return undefined;
          throw error;
        }
      });
      names.push('gw-fill-late');
      expect(reopened.status).toBe('ready');
    } finally {
      for (const name of names) await viaGateway().destroySandbox(name);
      // Leave the fleet as found: the gate reads the nodes' readings, which
      // catch up with the destroys at their next check-in — the next test
      // must not inherit a closed gate.
      await until(async () =>
        (await listNodes()).every(
          (n) =>
            n.reading?.sandboxes.byState.active === baseline.get(n.id) &&
            n.placedSinceCheckIn === 0,
        )
          ? true
          : undefined,
      );
    }
  });

  it('getFleetMetrics sums both nodes from their check-ins without asking them; getFleetStateHistory grows a point per check-in with a peak', async () => {
    const metrics = await viaGateway().getFleetMetrics();
    expect(metrics.nodes).toEqual({ total: 2, reachable: 2, reported: 2 });
    const own = await Promise.all(
      nodes().map((n) => direct(n.id).getHostMetrics()),
    );
    expect(metrics.sandboxes.total).toBe(
      own.reduce((sum, m) => sum + m.sandboxes.total, 0),
    );
    expect(metrics.sandboxDisks.count).toBe(
      own.reduce((sum, m) => sum + m.sandboxDisks.count, 0),
    );
    // A check-in a second: a couple of them bring points and a peak.
    const history = await until(async () => {
      const h = await viaGateway().getFleetStateHistory();
      return h.points.length >= 2 && h.peak !== null ? h : undefined;
    });
    for (const point of history.points) {
      const sum = Object.values(point.byState).reduce((a, b) => a + b, 0);
      expect(sum).toBe(point.total);
    }
    expect(history.bucketSeconds).toBeNull();
  });

  it('a host reading at the door names its node; unnamed in a fleet of two it is a 400 naming both', async () => {
    const b = await viaGateway().getHostMetrics({ nodeId: 'node-b' });
    const own = await direct('node-b').getHostMetrics();
    expect(b.host.cpuCount).toBe(own.host.cpuCount);
    expect(b.sandboxes.total).toBe(own.sandboxes.total);
    await expect(viaGateway().getHostMetrics()).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(
        /the fleet has 2 nodes \(node-b, node-c\)/,
      ),
    });
    const history = await viaGateway().getHostMetricsHistory({
      nodeId: 'node-c',
    });
    expect(history.points.length).toBeGreaterThanOrEqual(1);
  });

  it('the upgrade verbs are an honest 501 until their cut; a misspelled verb is a 404', async () => {
    await expect(viaGateway().checkUpgrade()).rejects.toMatchObject({
      status: 501,
      message: expect.stringMatching(/until the upgrade cut/),
    });
    expect((await rpc('/acquireSandbx', { name: 'x' })).status).toBe(404);
  });

  it("listSandboxes at the door is both nodes' lists with nobody silent; the E2B list pages across both nodes through the official package", async () => {
    const onB = await direct('node-b').acquireSandbox('gw-list-b');
    const onC = await direct('node-c').acquireSandbox('gw-list-c');
    try {
      const listed = await viaGateway().listSandboxes();
      expect(listed.silent).toEqual([]);
      const byName = new Map(listed.sandboxes.map((s) => [s.name, s.nodeId]));
      expect(byName.get('gw-list-b')).toBe('node-b');
      expect(byName.get('gw-list-c')).toBe('node-c');
      // A node's own list has nobody to be silent about.
      expect((await direct('node-b').listSandboxes()).silent).toBeUndefined();

      // apiUrl is not in the list options' type (it is in the create's),
      // but the paginator's ConnectionConfig reads it all the same — spread
      // in, past the literal's excess-property check, exactly as a caller
      // configuring a self-hosted door would.
      const connection = {
        apiKey: `e2b_${token()}`,
        apiUrl: `${gateway()}/e2b/api`,
      };
      const seen: string[] = [];
      const paginator = Sandbox.list({ ...connection, limit: 1 });
      while (paginator.hasNext) {
        for (const info of await paginator.nextItems())
          seen.push(info.sandboxId);
      }
      expect(seen).toContain(onB.sandbox.id);
      expect(seen).toContain(onC.sandbox.id);
      expect(new Set(seen).size).toBe(seen.length);
    } finally {
      await viaGateway().destroySandbox('gw-list-b');
      await viaGateway().destroySandbox('gw-list-c');
    }
  });

  it('the official e2b package works through the gateway: create, live streaming, files, kill; an unnamed create routes by id', async () => {
    const connection = {
      apiKey: `e2b_${token()}`,
      apiUrl: `${gateway()}/e2b/api`,
      sandboxUrl: `${gateway()}/e2b/envd`,
    };
    const sbx = await Sandbox.create({
      ...connection,
      metadata: { name: 'gw-e2b' },
    });
    try {
      const chunks: Array<{ text: string; at: number }> = [];
      const result = await sbx.commands.run(
        'echo first; sleep 1; echo second',
        {
          onStdout: (text) => {
            chunks.push({ text, at: Date.now() });
          },
        },
      );
      expect(result.stdout).toBe('first\nsecond\n');
      // Streaming through two hops: a real gap between the frames, as in
      // e2b.test.ts against the daemon alone — a buffering hop would
      // deliver both at once.
      const at = chunks.map((c) => c.at);
      expect(at.length).toBeGreaterThanOrEqual(2);
      expect((at.at(-1) ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(500);

      await sbx.files.write('/home/user/gateway.txt', 'through the gateway');
      expect(await sbx.files.read('/home/user/gateway.txt')).toBe(
        'through the gateway',
      );
      // The same name through the native face is the same sandbox.
      const found = await viaGateway().acquireSandbox('gw-e2b');
      expect(found.created).toBe(false);
      expect(found.sandbox.id).toBe(sbx.sandboxId);
    } finally {
      await sbx.kill();
    }
    expect(await viaGateway().destroySandbox('gw-e2b')).toEqual({
      destroyed: false,
    });

    const anonymous = await Sandbox.create(connection);
    try {
      const info = await fetch(
        `${connection.apiUrl}/sandboxes/${anonymous.sandboxId}`,
        { headers: { 'x-api-key': connection.apiKey } },
      );
      expect(info.status).toBe(200);
    } finally {
      await anonymous.kill();
    }
  });

  it('envd preflights are answered without a header; a signed URL the official package mints at the fleet door works at the fleet door — the door asks every node whose signature it is', async () => {
    const preflight = await fetch(`${gateway()}/e2b/envd/files`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    const stranger = await fetch(`${gateway()}/e2b/envd/files`, {
      headers: { 'e2b-sandbox-id': randomUUID() },
    });
    expect(stranger.status).toBe(502);
    expect(((await stranger.json()) as { code: string }).code).toBe(
      'unavailable',
    );

    // The SDK builds uploadUrl/downloadUrl off the sandboxUrl it was
    // given — `<door>/files?…signature=…`, no sandbox id in it, whatever
    // domain is in force (pinned here: this is the URL clawsgo's browser
    // opens). A bare fetch of it at the door must reach the node whose
    // sandbox signed it.
    const sbx = await Sandbox.create({
      apiKey: `e2b_${token()}`,
      apiUrl: `${gateway()}/e2b/api`,
      sandboxUrl: `${gateway()}/e2b/envd`,
      metadata: { name: 'gw-signed' },
    });
    try {
      await sbx.files.write('signed/hello.txt', 'signed at the door\n');
      const url = await sbx.downloadUrl('signed/hello.txt', {
        useSignatureExpiration: 300,
      });
      expect(url.startsWith(`${gateway()}/files?`)).toBe(true);
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.text()).toBe('signed at the door\n');

      const forged = new URL(url);
      forged.searchParams.set('signature', 'v1_forged');
      const refused = await fetch(forged);
      expect(refused.status).toBe(401);
      expect(refused.headers.get('access-control-allow-origin')).toBe('*');
      expect(await refused.json()).toEqual({
        code: 'unauthenticated',
        message: 'invalid signature',
      });

      const uploadUrl = await sbx.uploadUrl();
      const form = new FormData();
      form.append(
        'file',
        new Blob(['uploaded at the door\n']),
        'signed/up.txt',
      );
      const up = await fetch(uploadUrl, { method: 'POST', body: form });
      expect(up.status).toBe(200);
      expect(await sbx.files.read('signed/up.txt')).toBe(
        'uploaded at the door\n',
      );
    } finally {
      await sbx.kill();
    }
  });

  it('a third node joins at its first check-in; when it dies its sandboxes 502 and new names are a 503 naming it, until an operator removes it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dormice-e2e-node-d-'));
    const port = await freePort();
    const child = spawn('node', [inject('dormiceDaemonMain')], {
      env: {
        PATH: process.env.PATH ?? '',
        DORMICE_NODE_ID: 'node-d',
        DORMICE_PORT: String(port),
        DORMICE_DATA_DIR: dir,
        DORMICE_DB_PATH: join(dir, 'dormice.db'),
        DORMICE_API_TOKEN: token(),
        DORMICE_GATEWAY_ENDPOINT: gateway(),
        DORMICE_CHECK_IN_INTERVAL_SECONDS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise<void>((resolve) =>
      child.on('exit', () => resolve()),
    );
    const d = new Dormice({
      endpoint: `http://127.0.0.1:${port}`,
      token: token(),
    });
    try {
      // A booting node checks in before it listens (it takes its first
      // configuration bundle from that check-in): reachable with
      // configVersion null is "joined, not open yet"; the version it
      // reports at its first check-in after listen is the cue that its
      // port is open — placement waits for the same cue.
      await until(async () =>
        (await listNodes()).some(
          (n) => n.id === 'node-d' && n.reachable && n.configVersion !== null,
        )
          ? true
          : undefined,
      ).catch((error) => {
        throw new Error(`${String(error)}\n${output}`);
      });
      const staged = await d.acquireSandbox('gw-on-d');
      expect(
        (await viaGateway().execCommand('gw-on-d', 'echo on-d')).stdout,
      ).toBe('on-d\n');

      child.kill();
      await exited;
      await expect(
        viaGateway().execCommand('gw-on-d', 'true'),
      ).rejects.toMatchObject({
        status: 502,
        message: expect.stringMatching(/did not answer/),
      });
      const refused = await rpc('/acquireSandbox', { name: 'gw-while-d-down' });
      expect(refused.status).toBe(503);
      expect(message(refused)).toContain('node node-d did not answer');
      expect(refused.headers.get('retry-after')).toBe('15');
      // Down is also what listNodes says, on the node's own interval.
      await until(async () =>
        (await listNodes()).some((n) => n.id === 'node-d' && !n.reachable)
          ? true
          : undefined,
      );
      // The merged list is the other nodes' and says so: d's sandbox is
      // not in it, and d is named silent with the reason it was not even
      // asked — not a dial that waited the whole merge timeout.
      const partial = await viaGateway().listSandboxes();
      expect(partial.sandboxes.some((s) => s.name === 'gw-on-d')).toBe(false);
      expect(partial.silent).toEqual([
        { nodeId: 'node-d', why: expect.stringMatching(/has not checked in/) },
      ]);
      // The E2B list has nowhere to say what it lacks: a 503 naming d.
      const e2bList = await fetch(`${gateway()}/e2b/api/v2/sandboxes`, {
        headers: { 'x-api-key': `e2b_${token()}` },
      });
      expect(e2bList.status).toBe(503);
      expect((await e2bList.json()) as object).toMatchObject({
        code: 503,
        message: expect.stringMatching(/node node-d did not answer/),
      });

      expect((await rpc('/removeNode', { id: 'node-d' })).body).toEqual({
        removed: true,
      });
      expect((await listNodes()).some((n) => n.id === 'node-d')).toBe(false);
      // Removed, it is nobody's silence: the list is whole again.
      expect((await viaGateway().listSandboxes()).silent).toEqual([]);
      const placed = await viaGateway().acquireSandbox('gw-while-d-down');
      try {
        expect(['node-b', 'node-c']).toContain(placed.sandbox.nodeId);
      } finally {
        await viaGateway().destroySandbox('gw-while-d-down');
      }
      expect(staged.sandbox.nodeId).toBe('node-d');
    } finally {
      child.kill();
      await exited;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a gateway's boot, black-box: a second gateway on the same database file dies naming the conflict", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dormice-e2e-gateway-boot-'));
    try {
      const env = async () => ({
        PATH: process.env.PATH ?? '',
        DORMICE_GATEWAY_PORT: String(await freePort()),
        DORMICE_GATEWAY_DB_PATH: join(dir, 'gateway.db'),
        DORMICE_API_TOKEN: randomBytes(32).toString('hex'),
      });
      const first = await bootGateway(await env());
      expect(first.outcome, first.output).toBe('healthy');
      try {
        const second = await bootGateway(await env());
        expect(second.outcome, second.output).toEqual({ exitCode: 1 });
        expect(second.output).toMatch(
          /another gateway is already running against .*gateway\.db/,
        );
        expect(second.output).toContain('DORMICE_GATEWAY_DB_PATH');
      } finally {
        await first.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A port the OS just handed out and released — for a process this test boots itself. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Boots a gateway the production way (`node dist/main.js` + environment)
 * and reports how the boot ended: healthy at its port, or the exit code
 * it died with — its whole output kept for the assertion either way.
 */
async function bootGateway(env: Record<string, string>): Promise<{
  outcome: 'healthy' | { exitCode: number | null };
  output: string;
  kill: () => Promise<void>;
}> {
  const child = spawn('node', [inject('dormiceGatewayMain')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  let exited: number | null | undefined;
  const exit = new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      exited = code;
      resolve();
    });
  });
  const endpoint = `http://127.0.0.1:${env.DORMICE_GATEWAY_PORT}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      return { outcome: { exitCode: exited }, output, kill: async () => {} };
    }
    const healthy = await fetch(`${endpoint}/healthz`)
      .then((r) => r.ok)
      .catch(() => false);
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    outcome: exited === undefined ? 'healthy' : { exitCode: exited },
    output,
    kill: async () => {
      child.kill();
      await exit;
    },
  };
}
