import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it, vi } from 'vitest';
import { type Db, migrateDb, openDb } from './db/db';
import { createSandbox, overwriteState } from './db/ledger';
import {
  applyNodeConfig,
  archiveEnabled,
  NoConfigError,
  readConfigVersion,
  readNodeConfig,
  readRuntimeSettings,
  readS3Settings,
  readSwapTarget,
} from './db/settings';
import { findTemplate, resolveBaseImage } from './db/templates';
import { FAKE_BASE_IMAGE, FakeExecutor } from './executor/fake';
import { KeyedQueue } from './keyed-queue';
import { applyConfig, prefetchImages } from './node-config';
import type { SwapControl, SwapStatus } from './swap';
import { TEST_S3, testBundle } from './testing';

// The configuration copy: the pure write and its readers (db/settings.ts),
// and the applier that makes a bundle real on the host (node-config.ts).

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

function ledger(): Db {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return db;
}

function logSpy() {
  const lines: Array<{ level: string; msg: string; obj: unknown }> = [];
  const log = {
    info: (obj: unknown, msg: string) =>
      lines.push({ level: 'info', msg, obj }),
    warn: (obj: unknown, msg: string) =>
      lines.push({ level: 'warn', msg, obj }),
    error: (obj: unknown, msg: string) =>
      lines.push({ level: 'error', msg, obj }),
  };
  return { log, lines };
}

/** A swap manager that only records the targets it was asked to reconcile to. */
function fakeSwap(): SwapControl & { targets: number[] } {
  const targets: number[] = [];
  const status: SwapStatus = { activeGb: 0, blocks: [] };
  return {
    targets,
    status: async () => status,
    reconcile: async (targetGb) => {
      targets.push(targetGb);
      return status;
    },
  };
}

describe('the copy in the ledger', () => {
  it('holds no copy until a bundle is applied: readers refuse, the version is null', () => {
    const db = ledger();
    expect(readConfigVersion(db)).toBeNull();
    expect(() => readRuntimeSettings(db)).toThrow(NoConfigError);
    expect(() => readS3Settings(db)).toThrow(/no configuration copy yet/);
    expect(() => readSwapTarget(db)).toThrow(NoConfigError);
  });

  it('a bundle is written whole and read back the same, keys withheld from the view and kept for the store', () => {
    const db = ledger();
    const bundle = testBundle(
      {
        cpus: 2,
        memoryGb: 4,
        diskGb: 20,
        s3: TEST_S3,
        sandboxDomain: 'sbx.example.com',
        sandboxDomainAliases: ['alt.example.com'],
        pidsLimit: 512,
        swapGb: 16,
        // In name order, as the copy reads them back.
        templates: [
          { name: 'node', image: 'img-node' },
          { name: 'py', image: 'img-py' },
        ],
      },
      5,
    );
    applyNodeConfig(db, bundle);
    expect(readConfigVersion(db)).toBe(5);
    expect(readNodeConfig(db)).toEqual(bundle);
    const view = readRuntimeSettings(db);
    expect(view.s3).toEqual({
      endpoint: TEST_S3.endpoint,
      bucket: TEST_S3.bucket,
      region: TEST_S3.region,
      forcePathStyle: TEST_S3.forcePathStyle,
    });
    expect(JSON.stringify(view)).not.toContain('exam-secret');
    expect(readS3Settings(db)).toEqual(TEST_S3);
    expect(archiveEnabled(db)).toBe(true);
    expect(readSwapTarget(db)).toBe(16);
    expect(findTemplate(db, 'py')?.image).toBe('img-py');
  });

  it('the next bundle replaces everything: a store cleared, a template gone, a knob moved', () => {
    const db = ledger();
    applyNodeConfig(
      db,
      testBundle(
        { s3: TEST_S3, templates: [{ name: 'py', image: 'img-py' }] },
        1,
      ),
    );
    applyNodeConfig(
      db,
      testBundle({ templates: [{ name: 'node', image: 'img-node' }] }, 2),
    );
    expect(readConfigVersion(db)).toBe(2);
    expect(readRuntimeSettings(db).s3).toBeNull();
    expect(archiveEnabled(db)).toBe(false);
    expect(readRuntimeSettings(db).defaultPolicy).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      archiveAfterSeconds: null,
    });
    expect(findTemplate(db, 'py')).toBeUndefined();
    expect(findTemplate(db, 'node')?.image).toBe('img-node');
  });

  it('an old single-machine row (no version) is not a copy: readers refuse until the first bundle overwrites it', () => {
    const db = ledger();
    // What migration 0025 leaves behind on an upgraded machine: the row
    // with the daemon's own settings and config_version NULL.
    applyNodeConfig(db, testBundle({ pidsLimit: 999 }, 1));
    db.$client.exec(
      "UPDATE runtime_settings SET config_version = NULL, s3_endpoint = '' WHERE id = 1",
    );
    expect(readConfigVersion(db)).toBeNull();
    expect(() => readRuntimeSettings(db)).toThrow(NoConfigError);
    applyNodeConfig(db, testBundle({ pidsLimit: 512 }, 4));
    expect(readConfigVersion(db)).toBe(4);
    expect(readRuntimeSettings(db).pidsLimit).toBe(512);
    expect(readRuntimeSettings(db).s3).toBeNull();
  });
});

describe('applyConfig: the bundle made real on the host', () => {
  function node(cap = 4096) {
    const db = ledger();
    const executor = new FakeExecutor(
      undefined,
      () => readRuntimeSettings(db).pidsLimit,
    );
    const locks = new KeyedQueue();
    const swap = fakeSwap();
    const { log, lines } = logSpy();
    applyNodeConfig(db, testBundle({ pidsLimit: cap }, 1));
    return { db, executor, locks, swap, log, lines };
  }

  async function running(db: Db, executor: FakeExecutor, name: string) {
    const id = randomUUID();
    await executor.create(id);
    return createSandbox(db, {
      id,
      name,
      nodeId: 'node-test',
      policy: DEFAULT_LIFECYCLE_POLICY,
    });
  }

  it('the first copy is written and nothing else runs: boot does its own sweep and swap reconcile', async () => {
    const db = ledger();
    const executor = new FakeExecutor();
    const swap = fakeSwap();
    const { log, lines } = logSpy();
    await applyConfig(testBundle({ pidsLimit: 512, swapGb: 8 }, 1), {
      db,
      executor,
      locks: new KeyedQueue(),
      swap,
      log,
    });
    expect(readConfigVersion(db)).toBe(1);
    expect(swap.targets).toEqual([]);
    expect(lines.map((l) => l.msg)).toEqual([
      'first configuration copy applied from the gateway',
    ]);
  });

  it('a moved pids cap sweeps the running shells in place; frozen ones follow at their wake', async () => {
    const { db, executor, locks, swap, log } = node(4096);
    const busy = await running(db, executor, 'busy');
    const idle = await running(db, executor, 'idle');
    await executor.freeze(idle.id);
    overwriteState(db, idle.id, 'frozen');

    await applyConfig(testBundle({ pidsLimit: 2048 }, 2), {
      db,
      executor,
      locks,
      swap,
      log,
    });
    expect(readRuntimeSettings(db).pidsLimit).toBe(2048);
    expect(executor.pidsLimitOf(busy.id)).toBe(2048);
    expect(executor.stateOf(busy.id)).toBe('running');
    expect(executor.pidsLimitOf(idle.id)).toBe(4096);
    await executor.unfreeze(idle.id);
    expect(executor.pidsLimitOf(idle.id)).toBe(2048);
    // The swap target did not move: no reconcile.
    expect(swap.targets).toEqual([]);
  });

  it('a shell the runtime refuses is logged by name; the copy is applied all the same', async () => {
    const { db, executor, locks, swap, log, lines } = node(4096);
    await running(db, executor, 'stubborn');
    vi.spyOn(executor, 'convergePidsLimit').mockRejectedValue(
      new Error('runsc refused'),
    );
    await applyConfig(testBundle({ pidsLimit: 2048 }, 2), {
      db,
      executor,
      locks,
      swap,
      log,
    });
    expect(readConfigVersion(db)).toBe(2);
    const warned = lines.find((l) => l.level === 'warn');
    expect(warned?.msg).toMatch(/pids cap moved to 2048; 1 running shell/);
    expect((warned?.obj as { failures: string[] }).failures).toEqual([
      'stubborn: runsc refused',
    ]);
  });

  it('a moved swap target reconciles the managed swap; a failure is logged, never thrown', async () => {
    const { db, executor, locks, swap, log, lines } = node();
    await applyConfig(testBundle({ swapGb: 16 }, 2), {
      db,
      executor,
      locks,
      swap,
      log,
    });
    expect(swap.targets).toEqual([16]);
    expect(readSwapTarget(db)).toBe(16);
    // Same target again in a bundle that changed something else: no reconcile.
    await applyConfig(
      testBundle({ swapGb: 16, sandboxDomain: 'sbx.example.com' }, 3),
      { db, executor, locks, swap, log },
    );
    expect(swap.targets).toEqual([16]);

    const failing: SwapControl = {
      status: async () => ({ activeGb: 0, blocks: [] }),
      reconcile: async () => {
        throw new Error('fallocate: No space left on device');
      },
    };
    await expect(
      applyConfig(testBundle({ swapGb: 32 }, 4), {
        db,
        executor,
        locks,
        swap: failing,
        log,
      }),
    ).resolves.toBeUndefined();
    expect(readSwapTarget(db)).toBe(32);
    expect(lines.at(-1)?.level).toBe('error');
    expect(lines.at(-1)?.msg).toMatch(
      /swap reconcile after a configuration change failed/,
    );
  });

  it('without a swap manager the target is stored and nothing is reconciled', async () => {
    const { db, executor, locks, log } = node();
    await applyConfig(testBundle({ swapGb: 16 }, 2), {
      db,
      executor,
      locks,
      log,
    });
    expect(readSwapTarget(db)).toBe(16);
  });
});

describe('the base image: a fleet setting, the env a fallback', () => {
  it("resolveBaseImage answers the copy's, the env's while the copy names none, and refuses with where to set it when neither does", () => {
    const db = ledger();
    applyNodeConfig(db, testBundle({ baseImage: 'dormice-base:20260831' }, 1));
    expect(resolveBaseImage(db, 'dormice-base:20260718')).toBe(
      'dormice-base:20260831',
    );
    expect(resolveBaseImage(db, undefined)).toBe('dormice-base:20260831');
    applyNodeConfig(db, testBundle({ baseImage: null }, 2));
    expect(resolveBaseImage(db, 'dormice-base:20260718')).toBe(
      'dormice-base:20260718',
    );
    expect(() => resolveBaseImage(db, undefined)).toThrow(
      /no base image: the fleet settings name none and DORMICE_BASE_IMAGE is not set on this node — set baseImage at the gateway/,
    );
    // The copy carries the registry beside it, for the pull.
    applyNodeConfig(
      db,
      testBundle({ baseImage: 'b:1', registryAddress: '10.0.0.5:5000' }, 3),
    );
    expect(readRuntimeSettings(db)).toMatchObject({
      baseImage: 'b:1',
      registryAddress: '10.0.0.5:5000',
    });
  });

  it('a bundle naming no base image is a warning when the node has a fallback, nothing when it has none or the fleet names one', async () => {
    const db = ledger();
    const executor = new FakeExecutor();
    const apply = async (
      bundle: ReturnType<typeof testBundle>,
      fallback?: string,
    ) => {
      const { log, lines } = logSpy();
      await applyConfig(bundle, {
        db,
        executor,
        locks: new KeyedQueue(),
        log,
        baseImageFallback: fallback,
      });
      return lines.filter((l) => l.level === 'warn').map((l) => l.msg);
    };
    expect(await apply(testBundle({}, 1), 'dormice-base:20260718')).toEqual([
      expect.stringMatching(/the fleet settings name no base image/),
    ]);
    expect(await apply(testBundle({}, 2))).toEqual([]);
    expect(
      await apply(testBundle({ baseImage: 'b:1' }, 3), 'dormice-base:20260718'),
    ).toEqual([]);
  });

  it("prefetchImages pulls what the bundle names and the host lacks — the base and every template's image, once each — and a pull that fails is one warning, the rest still fetched", async () => {
    const executor = new FakeExecutor();
    const { log, lines } = logSpy();
    const bundle = testBundle(
      {
        baseImage: FAKE_BASE_IMAGE,
        templates: [
          { name: 'py', image: 'img-py:1' },
          { name: 'node', image: 'img-node:1' },
          { name: 'py-too', image: 'img-py:1' },
        ],
      },
      1,
    );
    await prefetchImages(bundle, executor, log);
    // The base is on the host (install.sh builds it); the two template
    // images were not, and the one named twice was pulled once.
    expect(executor.pulled).toEqual(['img-py:1', 'img-node:1']);
    expect(
      lines.map((l) => [l.level, (l.obj as { image: string }).image]),
    ).toEqual([
      ['info', 'img-py:1'],
      ['info', 'img-node:1'],
    ]);
    // Nothing new: nothing pulled, nothing said.
    lines.length = 0;
    await prefetchImages(bundle, executor, log);
    expect(executor.pulled).toEqual(['img-py:1', 'img-node:1']);
    expect(lines).toEqual([]);

    const failing = new FakeExecutor();
    vi.spyOn(failing, 'ensureImage').mockImplementation(async (image) => {
      if (image === 'img-gone:1') throw new Error('manifest unknown');
      return 'pulled';
    });
    const { log: log2, lines: lines2 } = logSpy();
    await prefetchImages(
      testBundle(
        {
          templates: [
            { name: 'gone', image: 'img-gone:1' },
            { name: 'ok', image: 'img-ok:1' },
          ],
        },
        1,
      ),
      failing,
      log2,
    );
    expect(lines2.map((l) => l.level)).toEqual(['warn', 'info']);
    expect(lines2[0]?.msg).toMatch(/could not be fetched ahead/);
    expect((lines2[0]?.obj as { image: string }).image).toBe('img-gone:1');
  });

  it("applyConfig starts the prefetch and does not wait for it: the bundle's images arrive after the copy is applied", async () => {
    const db = ledger();
    const executor = new FakeExecutor();
    const { log } = logSpy();
    await applyConfig(
      testBundle({ templates: [{ name: 'py', image: 'img-py:1' }] }, 1),
      { db, executor, locks: new KeyedQueue(), log },
    );
    expect(readConfigVersion(db)).toBe(1);
    await vi.waitFor(() => expect(executor.pulled).toEqual(['img-py:1']));
  });
});
