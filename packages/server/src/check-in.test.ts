import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { checkInRequestSchema } from '@dormice/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckIn, type CheckInOptions, readNodeReading } from './check-in';
import { migrateDb, openDb } from './db/db';
import { createSandbox } from './db/ledger';
import { CpuSampler } from './host-metrics';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const TOKEN = 'shared-token-shared-token-shared-token';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** A gateway-shaped listener: records every check-in, answers what the test says. */
async function gateway(answer: () => { status: number; body: string }) {
  const seen: Array<{ headers: http.IncomingHttpHeaders; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
    });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(text) });
      const a = answer();
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(a.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
  };
}

function logSpy() {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    log: {
      info: (msg: string) => infos.push(msg),
      warn: (_obj: unknown, msg: string) => warns.push(msg),
    },
  };
}

function options(
  gatewayEndpoint: string,
  log: CheckInOptions['log'],
  over: Partial<CheckInOptions> = {},
): CheckInOptions {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const cpu = new CpuSampler();
  return {
    gateway: gatewayEndpoint,
    token: TOKEN,
    nodeId: 'node-7',
    endpoint: 'http://10.0.0.7:80',
    intervalSeconds: 1,
    build: {
      commit: 'abc1234',
      title: 'a commit',
      committedAt: '2026-09-14T00:00:00.000Z',
    },
    readReading: () => readNodeReading(db, cpu, '/nonexistent-data-dir'),
    log,
    ...over,
  };
}

describe('CheckIn', () => {
  it('posts a check-in the gateway can parse: shared token, id, endpoint, interval, build, reading', async () => {
    const gw = await gateway(() => ({ status: 200, body: '{}' }));
    const { log, warns } = logSpy();
    await new CheckIn(options(gw.endpoint, log)).once();
    expect(warns).toEqual([]);
    expect(gw.seen).toHaveLength(1);
    expect(gw.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const body = checkInRequestSchema.parse(gw.seen[0]?.body);
    expect(body.nodeId).toBe('node-7');
    expect(body.endpoint).toBe('http://10.0.0.7:80');
    expect(body.intervalSeconds).toBe(1);
    expect(body.build?.commit).toBe('abc1234');
    expect(body.reading.host.cpuCount).toBeGreaterThan(0);
    // The first sample has no delta, and a data dir that does not exist is
    // an honest null, never a made-up disk.
    expect(body.reading.host.cpuUsedPct).toBeNull();
    expect(body.reading.dataDisk).toBeNull();
    expect(body.reading.sandboxes).toEqual({
      total: 0,
      byState: { active: 0, frozen: 0, stopped: 0, archived: 0, restoring: 0 },
    });
  });

  it('the reading counts the ledger by state', async () => {
    const db = openDb(':memory:');
    migrateDb(db, MIGRATIONS);
    for (const name of ['a', 'b']) {
      createSandbox(db, {
        id: `id-${name}`,
        name,
        nodeId: 'node-7',
        policy: {
          freezeAfterSeconds: 60,
          stopAfterSeconds: null,
          archiveAfterSeconds: null,
        },
        template: null,
        metadata: null,
        spec: undefined,
        actor: null,
      });
    }
    const reading = await readNodeReading(db, new CpuSampler(), '/tmp');
    expect(reading.sandboxes.total).toBe(2);
    expect(reading.sandboxes.byState.active).toBe(2);
    expect(reading.dataDisk?.path).toBe('/tmp');
  });

  it('logs a failing gateway once, and its recovery once — not every tick', async () => {
    let status = 500;
    const gw = await gateway(() => ({ status, body: '{"message":"boom"}' }));
    const { log, warns, infos } = logSpy();
    const checkIn = new CheckIn(options(gw.endpoint, log));
    await checkIn.once();
    await checkIn.once();
    expect(gw.seen).toHaveLength(2);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/check-in failed/);
    status = 200;
    await checkIn.once();
    await checkIn.once();
    expect(infos).toEqual([
      `check-in with gateway ${gw.endpoint} answers again`,
    ]);
    expect(warns).toHaveLength(1);
    // A gateway that refuses the token is the same one event.
    status = 401;
    await checkIn.once();
    await checkIn.once();
    expect(warns).toHaveLength(2);
  });

  it('a gateway that is not there is a logged failure, never a throw', async () => {
    const { log, warns } = logSpy();
    const checkIn = new CheckIn(options('http://127.0.0.1:9', log));
    await expect(checkIn.once()).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
  });

  it('ticks on its interval from start() and stops on stop()', async () => {
    const gw = await gateway(() => ({ status: 200, body: '{}' }));
    const { log } = logSpy();
    const checkIn = new CheckIn(options(gw.endpoint, log));
    checkIn.start();
    const deadline = Date.now() + 5_000;
    while (gw.seen.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(gw.seen.length).toBeGreaterThanOrEqual(2);
    checkIn.stop();
    const afterStop = gw.seen.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(gw.seen.length).toBe(afterStop);
  });
});
