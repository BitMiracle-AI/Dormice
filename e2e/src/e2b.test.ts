import { CommandExitError, Sandbox } from 'e2b';
import { describe, expect, inject, it } from 'vitest';

// The compatibility promise, verified with the promise's own artifact: the
// OFFICIAL e2b package, pointed at the daemon by exactly two URLs (plus its
// API key). Nothing in here imports Dormice code — if these tests pass, a
// real E2B application migrates by changing configuration, not code.
const connection = () => ({
  apiKey: `e2b_${inject('dormiceToken')}`,
  apiUrl: `${inject('dormiceEndpoint')}/e2b/api`,
  sandboxUrl: `${inject('dormiceEndpoint')}/e2b/envd`,
});

function sleep(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

describe('official e2b SDK against the daemon', () => {
  it('creates a sandbox and runs a command', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      expect(sbx.sandboxId).toBeTruthy();
      const result = await sbx.commands.run('echo hello-dormice');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello-dormice\n');
    } finally {
      await sbx.kill();
    }
  });

  it('throws CommandExitError on a nonzero exit — the SDK’s own contract', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      const error = await sbx.commands.run('exit 3').catch((e) => e);
      expect(error).toBeInstanceOf(CommandExitError);
      expect(error.exitCode).toBe(3);
    } finally {
      await sbx.kill();
    }
  });

  it('streams output live through onStdout, not buffered', async () => {
    const sbx = await Sandbox.create(connection());
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
      const at = chunks.map((c) => c.at);
      // A real gap between chunks is what "streaming" means; a buffered
      // implementation delivers everything at once.
      expect(Math.max(...at) - Math.min(...at)).toBeGreaterThanOrEqual(500);
    } finally {
      await sbx.kill();
    }
  });

  it('honors cwd and envs per command, with sandbox envs underneath', async () => {
    const sbx = await Sandbox.create({
      ...connection(),
      envs: { FROM_SANDBOX: 'base-value' },
    });
    try {
      const cwd = await sbx.commands.run('pwd', { cwd: '/tmp' });
      expect(cwd.stdout).toBe('/tmp\n');
      const fromSandbox = await sbx.commands.run('printenv FROM_SANDBOX');
      expect(fromSandbox.stdout).toBe('base-value\n');
      const shadowed = await sbx.commands.run('printenv FROM_SANDBOX', {
        envs: { FROM_SANDBOX: 'per-command' },
      });
      expect(shadowed.stdout).toBe('per-command\n');
    } finally {
      await sbx.kill();
    }
  });

  it('writes, reads, lists, stats, renames and removes files', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      const entry = await sbx.files.write(
        'notes/hello.txt',
        '你好,Dormice ✓\n',
      );
      expect(entry.path).toBe('/home/user/notes/hello.txt');
      expect(await sbx.files.read('notes/hello.txt')).toBe('你好,Dormice ✓\n');

      // The array form writes a batch.
      await sbx.files.write([
        { path: 'notes/a.txt', data: 'a' },
        { path: 'notes/b.txt', data: 'b' },
      ]);
      const names = (await sbx.files.list('notes')).map((e) => e.name).sort();
      expect(names).toEqual(['a.txt', 'b.txt', 'hello.txt']);

      expect(await sbx.files.exists('notes/a.txt')).toBe(true);
      expect(await sbx.files.exists('notes/void.txt')).toBe(false);

      const info = await sbx.files.getInfo('notes/a.txt');
      expect(info.type).toBe('file');
      expect(Number(info.size)).toBe(1);

      const renamed = await sbx.files.rename('notes/a.txt', 'notes/z.txt');
      expect(renamed.path).toBe('/home/user/notes/z.txt');

      expect(await sbx.files.makeDir('notes/deep/er')).toBe(true);
      expect(await sbx.files.makeDir('notes/deep/er')).toBe(false);

      await sbx.files.remove('notes');
      expect(await sbx.files.exists('notes')).toBe(false);
    } finally {
      await sbx.kill();
    }
  });

  it('round-trips bytes exactly', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      const bytes = new Uint8Array(512).map((_, i) => i % 256);
      await sbx.files.write('blob.bin', bytes.buffer);
      const back = await sbx.files.read('blob.bin', { format: 'bytes' });
      expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
    } finally {
      await sbx.kill();
    }
  });

  it('reports info, appears in list, and can be found by metadata', async () => {
    const sbx = await Sandbox.create({
      ...connection(),
      metadata: { suite: 'e2b-e2e', run: 'metadata-lookup' },
    });
    try {
      expect(await sbx.isRunning()).toBe(true);
      const info = await sbx.getInfo();
      expect(info.state).toBe('running');
      expect(info.metadata).toMatchObject({ run: 'metadata-lookup' });

      const found = await Sandbox.list({
        ...connection(),
        query: { metadata: { run: 'metadata-lookup' } },
      }).nextItems();
      expect(found.map((s) => s.sandboxId)).toContain(sbx.sandboxId);
    } finally {
      await sbx.kill();
    }
  });

  it('kill destroys for real: gone from list, connect refuses, second kill is false', async () => {
    const sbx = await Sandbox.create(connection());
    await sbx.files.write('doomed.txt', 'will not survive');
    expect(await sbx.kill()).toBe(true);

    expect(await sbx.isRunning()).toBe(false);
    await expect(Sandbox.connect(sbx.sandboxId, connection())).rejects.toThrow(
      /not found/i,
    );
    expect(await Sandbox.kill(sbx.sandboxId, connection())).toBe(false);
  });

  it('a sandbox dies at its timeout — E2B semantics, honored for real', async () => {
    const sbx = await Sandbox.create({ ...connection(), timeoutMs: 2_000 });
    expect(await sbx.isRunning()).toBe(true);
    // Past the deadline plus a scanner sweep (the e2e daemon sweeps every
    // second): the sandbox must be protocol-dead and physically reaped.
    await sleep(3.5);
    expect(await sbx.isRunning()).toBe(false);
    await expect(Sandbox.connect(sbx.sandboxId, connection())).rejects.toThrow(
      /not found/i,
    );
  });

  it('onTimeout pause parks the sandbox instead; connect revives it, files intact', async () => {
    const sbx = await Sandbox.create({
      ...connection(),
      timeoutMs: 2_000,
      lifecycle: { onTimeout: 'pause' },
    });
    try {
      await sbx.files.write('keep.txt', 'still here');
      await sleep(3.5);
      expect(await sbx.isRunning()).toBe(false);
      const info = await sbx.getInfo();
      expect(info.state).toBe('paused');

      const revived = await Sandbox.connect(sbx.sandboxId, connection());
      expect(await revived.isRunning()).toBe(true);
      expect(await revived.files.read('keep.txt')).toBe('still here');
    } finally {
      await Sandbox.kill(sbx.sandboxId, connection()).catch(() => {});
    }
  }, 20_000);

  it('pause and connect: explicit pause parks, connect resumes, files intact', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      await sbx.files.write('nap.txt', 'through the nap');
      expect(await sbx.pause()).toBe(true);
      expect(await sbx.isRunning()).toBe(false);
      expect((await sbx.getInfo()).state).toBe('paused');
      // Pausing an already-paused sandbox reports false, not an error.
      expect(await sbx.pause()).toBe(false);

      const revived = await Sandbox.connect(sbx.sandboxId, connection());
      expect((await revived.getInfo()).state).toBe('running');
      expect(await revived.files.read('nap.txt')).toBe('through the nap');
    } finally {
      await Sandbox.kill(sbx.sandboxId, connection()).catch(() => {});
    }
  });

  it('setTimeout extends the lease', async () => {
    const sbx = await Sandbox.create({ ...connection(), timeoutMs: 2_000 });
    try {
      await sbx.setTimeout(600_000);
      await sleep(3.5);
      // Without the extension this sandbox would be dead by now.
      expect(await sbx.isRunning()).toBe(true);
    } finally {
      await sbx.kill();
    }
  });

  it('the Dormice extension: metadata.userKey makes create idempotent, data persists', async () => {
    const first = await Sandbox.create({
      ...connection(),
      metadata: { userKey: 'e2e-agent-key' },
    });
    try {
      await first.files.write('persistent.txt', 'same sandbox every time');
      const second = await Sandbox.create({
        ...connection(),
        metadata: { userKey: 'e2e-agent-key' },
      });
      expect(second.sandboxId).toBe(first.sandboxId);
      expect(await second.files.read('persistent.txt')).toBe(
        'same sandbox every time',
      );
    } finally {
      await first.kill();
    }
  });
});

// Identity and real-shell behavior only a real container can answer; the
// pocket interpreter has no users or profiles. The docker-mode e2e run on
// the test machine covers these.
describe.runIf(process.env.DORMICE_EXECUTOR === 'docker')(
  'official e2b SDK, docker executor only',
  () => {
    it('commands run as user (uid 1000), never root', async () => {
      const sbx = await Sandbox.create(connection());
      try {
        const result = await sbx.commands.run('whoami && id -u');
        expect(result.stdout).toBe('user\n1000\n');
      } finally {
        await sbx.kill();
      }
    });

    it('runs a login shell: the image profile is loaded', async () => {
      const sbx = await Sandbox.create(connection());
      try {
        // `bash -l -c` sources the profile; $HOME comes from the user entry.
        const result = await sbx.commands.run('echo $HOME');
        expect(result.stdout).toBe('/home/user\n');
      } finally {
        await sbx.kill();
      }
    });
  },
);
