import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { checkInRequestSchema, type NodeConfigBundle } from '@dormice/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckIn, type CheckInOptions, readNodeReading } from './check-in';
import { migrateDb, openDb } from './db/db';
import { createSandbox } from './db/ledger';
import { applyNodeConfig, readConfigVersion } from './db/settings';
import { CpuSampler } from './host-metrics';
import { testBundle } from './testing';

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
async function gateway(
  answer: () => {
    status: number;
    body: string;
    headers?: Record<string, string>;
  },
) {
  const seen: Array<{ headers: http.IncomingHttpHeaders; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
    });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(text) });
      const a = answer();
      res.writeHead(a.status, {
        'content-type': 'application/json',
        ...a.headers,
      });
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
  const details: unknown[] = [];
  return {
    infos,
    warns,
    details,
    log: {
      info: (msg: string) => infos.push(msg),
      warn: (obj: unknown, msg: string) => {
        warns.push(msg);
        details.push(obj);
      },
    },
  };
}

/** A gateway answer: the current version, and the bundle when the node's differs. */
function answering(version: number, bundle?: NodeConfigBundle) {
  return {
    status: 200,
    body: JSON.stringify({
      configVersion: version,
      ...(bundle === undefined ? {} : { config: bundle }),
    }),
  };
}

function options(
  gatewayEndpoint: string,
  log: CheckInOptions['log'],
  over: Partial<CheckInOptions> = {},
): CheckInOptions & { db: ReturnType<typeof openDb> } {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const cpu = new CpuSampler();
  return {
    db,
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
    // The daemon's wiring in miniature: the copy is the ledger's, applied
    // by the pure write (node-config.ts's hooks are its own suite).
    configVersion: () => readConfigVersion(db),
    applyConfig: async (bundle) => applyNodeConfig(db, bundle),
    log,
    ...over,
  };
}

describe('CheckIn', () => {
  it('posts a check-in the gateway can parse: shared token, id, endpoint, interval, build, reading', async () => {
    const gw = await gateway(() => answering(1));
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
    // No swap manager here: honestly "cannot manage swap", and no copy yet.
    expect(body.reading.managedSwap).toBeNull();
    expect(body.configVersion).toBeNull();
  });

  it('the reading carries the managed swap when the daemon has one', async () => {
    const db = openDb(':memory:');
    migrateDb(db, MIGRATIONS);
    const reading = await readNodeReading(db, new CpuSampler(), '/tmp', {
      status: async () => ({ activeGb: 16, blocks: [] }),
      reconcile: async () => ({ activeGb: 16, blocks: [] }),
    });
    expect(reading.managedSwap).toEqual({ activeGb: 16 });
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
      });
    }
    const reading = await readNodeReading(db, new CpuSampler(), '/tmp');
    expect(reading.sandboxes.total).toBe(2);
    expect(reading.sandboxes.byState.active).toBe(2);
    expect(reading.dataDisk?.path).toBe('/tmp');
  });

  it('logs a failing gateway once, and its recovery once — not every tick', async () => {
    let status = 500;
    const gw = await gateway(() =>
      status === 200 ? answering(1) : { status, body: '{"message":"boom"}' },
    );
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

  it('a front that redirects is reported as a wrong address, not followed with the token stripped', async () => {
    const gw = await gateway(() => ({
      status: 308,
      body: '',
      headers: { location: 'https://gateway.example/checkIn' },
    }));
    const { log, warns, details } = logSpy();
    await new CheckIn(options(gw.endpoint, log)).once();
    expect(gw.seen).toHaveLength(1);
    expect(warns).toEqual([expect.stringMatching(/check-in failed/)]);
    expect((details[0] as { error: string }).error).toMatch(
      /gateway answered 308 redirecting to https:\/\/gateway\.example\/checkIn — DORMICE_GATEWAY_ENDPOINT must be the gateway's own address/,
    );
  });

  it("a refusal's whole sentence reaches the log — the 409 for a shared node id names two endpoints and a remedy past the 200th character", async () => {
    const refusal =
      'node node-7 checked in from http://10.0.0.7:80 3s ago and now from http://10.0.0.8:80 — two daemons share one DORMICE_NODE_ID (give this one its own), or the node just moved (then its next check-in, an interval later, is taken)';
    const gw = await gateway(() => ({
      status: 409,
      body: JSON.stringify({ message: refusal }),
    }));
    const { log, details } = logSpy();
    await new CheckIn(options(gw.endpoint, log)).once();
    expect((details[0] as { error: string }).error).toBe(
      `gateway answered 409: ${JSON.stringify({ message: refusal })}`,
    );
  });

  it('a failure that changes is logged again — unreachable, then refused, are two events — while the same refusal with another number in it is not', async () => {
    let answer = { status: 500, body: '{"message":"boom"}' };
    const gw = await gateway(() => answer);
    const { log, warns, details } = logSpy();
    const checkIn = new CheckIn(options(gw.endpoint, log));
    await checkIn.once();
    await checkIn.once();
    expect(warns).toHaveLength(1);
    const refusal = (ago: number) =>
      JSON.stringify({
        message: `node node-7 checked in from http://10.0.0.7:80 ${ago}s ago and now from http://10.0.0.8:80 — two daemons share one DORMICE_NODE_ID`,
      });
    answer = { status: 409, body: refusal(3) };
    await checkIn.once();
    answer = { status: 409, body: refusal(4) };
    await checkIn.once();
    expect(warns).toHaveLength(2);
    expect(warns[1]).toMatch(/still failing, differently/);
    expect((details[1] as { error: string }).error).toMatch(
      /gateway answered 409: .*3s ago/,
    );
  });

  it("a gateway that is not there is a logged failure, never a throw, and the log says why in the transport's word", async () => {
    // A port the OS just released: dialling it is refused, not black-holed.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { log, warns, details } = logSpy();
    const checkIn = new CheckIn(options(`http://127.0.0.1:${port}`, log));
    await expect(checkIn.once()).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
    expect((details[0] as { error: string }).error).toMatch(
      /fetch failed \(ECONNREFUSED\)/,
    );
  });

  it('a bundle in the answer is applied and the next check-in reports its version; a matching version gets no bundle', async () => {
    const bundle = testBundle(
      { sandboxDomain: 'sbx.example.com', pidsLimit: 512 },
      7,
    );
    let sent = 0;
    const gw = await gateway(() => {
      sent += 1;
      return sent === 1 ? answering(7, bundle) : answering(7);
    });
    const { log, warns, infos } = logSpy();
    const opts = options(gw.endpoint, log);
    const checkIn = new CheckIn(opts);
    await checkIn.once();
    expect(warns).toEqual([]);
    expect(readConfigVersion(opts.db)).toBe(7);
    await checkIn.once();
    expect(checkInRequestSchema.parse(gw.seen[1]?.body).configVersion).toBe(7);
    expect(infos).toEqual([]);
  });

  it("a bundle that cannot be applied is this tick's failure, and the version stays so the gateway sends it again", async () => {
    const bundle = testBundle({}, 3);
    const gw = await gateway(() => answering(3, bundle));
    const { log, warns, details } = logSpy();
    const opts = options(gw.endpoint, log, {
      applyConfig: async () => {
        throw new Error('disk full');
      },
    });
    const checkIn = new CheckIn(opts);
    await checkIn.once();
    expect(warns).toHaveLength(1);
    expect((details[0] as { error: string }).error).toMatch(
      /configuration v3 from the gateway could not be applied: disk full/,
    );
    expect(readConfigVersion(opts.db)).toBeNull();
    // The next check-in still says "no copy" — the gateway's cue to resend.
    await checkIn.once();
    expect(
      checkInRequestSchema.parse(gw.seen[1]?.body).configVersion,
    ).toBeNull();
  });

  it('untilConfigured() asks until a bundle lands, on the interval, beating the watchdog per attempt, and returns at once when a copy exists', async () => {
    let sent = 0;
    const gw = await gateway(() => {
      sent += 1;
      // The gateway is down for the first two asks, then answers with the bundle.
      return sent < 3
        ? { status: 503, body: '{"message":"starting"}' }
        : answering(2, testBundle({}, 2));
    });
    const { log } = logSpy();
    let beats = 0;
    const beat = () => {
      beats += 1;
    };
    const opts = options(gw.endpoint, log);
    const checkIn = new CheckIn(opts);
    const started = Date.now();
    await checkIn.untilConfigured(beat);
    expect(readConfigVersion(opts.db)).toBe(2);
    expect(gw.seen).toHaveLength(3);
    // Two waits of one interval between the three asks.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    // Every attempt, the two refused ones included, beat the watchdog: a
    // node waiting for its gateway is alive, not stalled.
    expect(beats).toBe(3);
    // Holding a copy already: nothing is asked, nothing beats.
    await checkIn.untilConfigured(beat);
    expect(gw.seen).toHaveLength(3);
    expect(beats).toBe(3);
  });

  it("the first failure's sentence names the cost for where the node stands: not listening without a copy, not placed on with one", async () => {
    const gw = await gateway(() => ({
      status: 503,
      body: '{"message":"starting"}',
    }));
    const bare = logSpy();
    await new CheckIn(options(gw.endpoint, bare.log)).once();
    expect(bare.warns).toEqual([
      expect.stringMatching(
        /^check-in failed; this node holds no configuration copy and does not listen until it has applied one from the gateway/,
      ),
    ]);
    const holding = logSpy();
    const opts = options(gw.endpoint, holding.log);
    applyNodeConfig(opts.db, testBundle({}, 1));
    await new CheckIn(opts).once();
    expect(holding.warns).toEqual([
      expect.stringMatching(
        /^check-in failed; the gateway places nothing here and forwards no new names to this node/,
      ),
    ]);
  });

  it('ticks on its interval from start() and stops on stop()', async () => {
    const gw = await gateway(() => answering(1));
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
