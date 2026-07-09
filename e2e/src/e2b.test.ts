import { createHmac } from 'node:crypto';
import http from 'node:http';
import { Dormice } from '@dormice/sdk';
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

/** Polls until the observation holds — terminal output has no fixed schedule. */
async function until(check: () => boolean, timeoutMs = 8_000) {
  const before = Date.now();
  while (!check()) {
    if (Date.now() - before > timeoutMs) {
      throw new Error('condition never became true');
    }
    await sleep(0.05);
  }
}

/**
 * A GET at the daemon with a spoofed Host header — exactly what traffic
 * from a wildcard-DNS reverse proxy looks like, no DNS needed (fetch
 * refuses to set Host, so this speaks node:http directly).
 */
function throughProxy(
  host: string,
  path = '/',
): Promise<{ status: number; body: string }> {
  const endpoint = new URL(inject('dormiceEndpoint'));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: endpoint.hostname,
        port: endpoint.port,
        path,
        headers: { host },
      },
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

  it('background commands: run detached, kill through the handle', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      const handle = await sbx.commands.run('sleep 30', { background: true });
      expect(handle.pid).toBeGreaterThan(0);
      expect(await handle.kill()).toBe(true);
      const error = await handle.wait().catch((e) => e);
      expect(error).toBeInstanceOf(CommandExitError);
      expect(error.exitCode).toBe(137);
    } finally {
      await sbx.kill();
    }
  });

  it('disconnect does not kill: commands.connect reattaches and sees the ending', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      const handle = await sbx.commands.run('sleep 1; echo late-news', {
        background: true,
      });
      await handle.disconnect();

      const seen: string[] = [];
      const reattached = await sbx.commands.connect(handle.pid, {
        onStdout: (text) => {
          seen.push(text);
        },
      });
      const result = await reattached.wait();
      expect(result.exitCode).toBe(0);
      expect(seen.join('')).toBe('late-news\n');
    } finally {
      await sbx.kill();
    }
  });

  it('commands.list shows the living and empties after they exit', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      const handle = await sbx.commands.run('sleep 30', { background: true });
      const listed = await sbx.commands.list();
      expect(listed.map((p) => p.pid)).toContain(handle.pid);
      expect(listed[0]?.cmd).toBe('/bin/bash');

      await handle.kill();
      await handle.wait().catch(() => {});
      expect(await sbx.commands.list()).toEqual([]);
    } finally {
      await sbx.kill();
    }
  });

  it('stdin: sendStdin feeds the command, closeStdin is EOF', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      const seen: string[] = [];
      const handle = await sbx.commands.run('cat', {
        background: true,
        stdin: true,
        onStdout: (text) => {
          seen.push(text);
        },
      });
      await handle.sendStdin('hello ');
      await handle.sendStdin('dormice');
      await handle.closeStdin();
      const result = await handle.wait();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello dormice');
      expect(seen.join('')).toBe('hello dormice');
    } finally {
      await sbx.kill();
    }
  });

  it('pty.create: a live terminal — typed input runs, resize lands, kill ends it', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      const seen: string[] = [];
      const term = await sbx.pty.create({
        cols: 80,
        rows: 24,
        onData: (data) => {
          seen.push(Buffer.from(data).toString('utf8'));
        },
      });
      expect(term.pid).toBeGreaterThan(0);

      await sbx.pty.sendInput(
        term.pid,
        new TextEncoder().encode('echo from-the-pty\r'),
      );
      await until(() => seen.join('').includes('from-the-pty'));

      await sbx.pty.resize(term.pid, { cols: 120, rows: 40 });
      await sbx.pty.sendInput(
        term.pid,
        new TextEncoder().encode('stty size\r'),
      );
      await until(() => seen.join('').includes('40 120'));

      expect(await sbx.pty.kill(term.pid)).toBe(true);
      expect(await sbx.pty.kill(term.pid)).toBe(false);
    } finally {
      await sbx.kill();
    }
  });

  it('getHost builds the wildcard host from the served domain', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      // Pure client-side string assembly — but from OUR domain field, which
      // is the whole point: the daemon told the SDK where sandboxes live.
      expect(sbx.getHost(8000)).toBe(`8000-${sbx.sandboxId}.sbx.dormice.test`);
    } finally {
      await sbx.kill();
    }
  });

  it('watchDir streams filesystem events for changes made through the SDK', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      const events: Array<{ name: string; type: string }> = [];
      const handle = await sbx.files.watchDir(
        '/home/user',
        (event) => {
          events.push({ name: event.name, type: event.type });
        },
        { recursive: true, timeoutMs: 30_000 },
      );
      await sbx.files.write('watched.txt', 'hello');
      await until(() =>
        events.some((e) => e.name === 'watched.txt' && e.type === 'create'),
      );
      // Recursive: a change deep in the tree arrives with its relative path.
      await sbx.files.makeDir('nested');
      await sbx.files.write('nested/deep.txt', 'deeper');
      await until(() =>
        events.some((e) => e.name === 'nested/deep.txt' && e.type === 'create'),
      );
      await handle.stop();
    } finally {
      await sbx.kill();
    }
  });

  it('an attached watch does not keep the sandbox warm; waking it resumes events', async () => {
    // The product thesis applied to watch: watching is passive, so the idle
    // scanner freezes a watched sandbox — and no event is lost, because the
    // disk only changes from inside, and reaching inside wakes it first.
    // Reverse-proven: with an exec heartbeat attached to the watch stream,
    // the freeze below never happens and this test times out.
    const dormice = new Dormice({
      endpoint: inject('dormiceEndpoint'),
      token: inject('dormiceToken'),
    });
    const userKey = `watch-freeze-${Date.now()}`;
    // Native acquire sets the second-scale policy; the e2b face then joins
    // the same sandbox through the userKey extension.
    await dormice.acquireSandbox(userKey, {
      freezeAfterSeconds: 1,
      stopAfterSeconds: null,
    });
    const sbx = await Sandbox.create({
      ...connection(),
      metadata: { userKey },
    });
    try {
      const events: Array<{ name: string; type: string }> = [];
      const handle = await sbx.files.watchDir(
        '/home/user',
        (event) => {
          events.push({ name: event.name, type: event.type });
        },
        { timeoutMs: 60_000 },
      );
      // The real wall-clock scanner freezes the sandbox under the open watch.
      const frozen = async () => {
        const sandboxes = await dormice.listSandboxes();
        return sandboxes.find((s) => s.userKey === userKey)?.state;
      };
      const deadline = Date.now() + 15_000;
      while ((await frozen()) !== 'frozen') {
        if (Date.now() > deadline) throw new Error('sandbox never froze');
        await sleep(0.2);
      }
      // Any touch from outside wakes it; the watcher resumes and reports.
      await sbx.files.write('woke-up.txt', 'events survive the ice age');
      await until(
        () =>
          events.some((e) => e.name === 'woke-up.txt' && e.type === 'create'),
        10_000,
      );
      await handle.stop();
    } finally {
      await dormice.releaseSandbox(userKey);
    }
  });

  it('the polling watcher trio works over the wire — what the sync SDKs use', async () => {
    const sbx = await Sandbox.create(connection());
    try {
      // The JS SDK never calls these three; drive them as raw Connect unary
      // posts, the way a sync SDK would. The access token is the documented
      // envd HMAC — this stays a black-box network test.
      const rpc = async (method: string, body: Record<string, unknown>) => {
        const res = await fetch(
          `${inject('dormiceEndpoint')}/e2b/envd/filesystem.Filesystem/${method}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'e2b-sandbox-id': sbx.sandboxId,
              'x-access-token': createHmac('sha256', inject('dormiceToken'))
                .update(`envd:${sbx.sandboxId}`)
                .digest('hex'),
            },
            body: JSON.stringify(body),
          },
        );
        return {
          status: res.status,
          json: (await res.json()) as Record<string, unknown>,
        };
      };
      const created = await rpc('CreateWatcher', { path: '/home/user' });
      expect(created.status).toBe(200);
      const watcherId = created.json.watcherId as string;

      await sbx.files.write('polled.txt', 'x');
      // Poll like a sync SDK: drain until the event shows up.
      let drained: Array<{ name: string; type: string }> = [];
      const deadline = Date.now() + 8_000;
      while (
        !drained.some(
          (e) => e.name === 'polled.txt' && e.type === 'EVENT_TYPE_CREATE',
        )
      ) {
        if (Date.now() > deadline) throw new Error('event never arrived');
        const got = await rpc('GetWatcherEvents', { watcherId });
        drained = drained.concat(
          (got.json.events ?? []) as Array<{ name: string; type: string }>,
        );
        await sleep(0.1);
      }

      const removed = await rpc('RemoveWatcher', { watcherId });
      expect(removed.status).toBe(200);
      const gone = await rpc('GetWatcherEvents', { watcherId });
      expect(gone.status).toBe(404);
      expect(gone.json.code).toBe('not_found');
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

// The proxy's end-to-end round trip against the fake executor's echo
// upstream; docker mode reaches a real in-sandbox server instead (below).
describe.runIf(process.env.DORMICE_EXECUTOR !== 'docker')(
  'sandbox port proxy, fake executor',
  () => {
    it('a Host-routed request lands inside the sandbox and echoes back', async () => {
      const sbx = await Sandbox.create(connection());
      try {
        const host = sbx.getHost(8000);
        const res = await throughProxy(host, '/hello?from=e2e');
        expect(res.status).toBe(200);
        const echo = JSON.parse(res.body);
        expect(echo.sandboxId).toBe(sbx.sandboxId);
        expect(echo.path).toBe('/hello?from=e2e');
        expect(echo.host).toBe(host);
      } finally {
        await sbx.kill();
      }
    });
  },
);

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

    it('getHost reaches a real server started in the sandbox', async () => {
      const sbx = await Sandbox.create(connection());
      try {
        await sbx.commands.run('python3 -m http.server 8000 --directory /tmp', {
          background: true,
        });
        const host = sbx.getHost(8000);
        // The server takes a beat to bind; poll through the proxy.
        let last = { status: 0, body: '' };
        await until(() => {
          void throughProxy(host, '/').then((res) => {
            last = res;
          });
          return last.status === 200;
        });
        expect(last.body.length).toBeGreaterThan(0);
      } finally {
        await sbx.kill();
      }
    });

    it('a port nobody listens on answers 502, honestly', async () => {
      const sbx = await Sandbox.create(connection());
      try {
        const res = await throughProxy(sbx.getHost(9999), '/');
        expect(res.status).toBe(502);
        expect(JSON.parse(res.body).message).toContain('not listening');
      } finally {
        await sbx.kill();
      }
    });

    it('a real chmod arrives as a chmod event — only a real kernel emits ATTRIB', async () => {
      const sbx = await Sandbox.create(connection());
      try {
        await sbx.files.write('mode-me.txt', 'x');
        const events: Array<{ name: string; type: string }> = [];
        const handle = await sbx.files.watchDir(
          '/home/user',
          (event) => {
            events.push({ name: event.name, type: event.type });
          },
          { timeoutMs: 30_000 },
        );
        await sbx.commands.run('chmod 600 /home/user/mode-me.txt');
        await until(() =>
          events.some((e) => e.name === 'mode-me.txt' && e.type === 'chmod'),
        );
        await handle.stop();
      } finally {
        await sbx.kill();
      }
    });

    it('the PTY runs a real interactive bash on the sandbox disk', async () => {
      const sbx = await Sandbox.create(connection());
      try {
        const seen: string[] = [];
        const term = await sbx.pty.create({
          cols: 80,
          rows: 24,
          onData: (data) => {
            seen.push(Buffer.from(data).toString('utf8'));
          },
        });
        // ls of the disk root: only a real shell on the real disk shows
        // mkfs's lost+found.
        await sbx.pty.sendInput(
          term.pid,
          new TextEncoder().encode('ls /home/user\r'),
        );
        await until(() => seen.join('').includes('lost+found'));
        await sbx.pty.kill(term.pid);
      } finally {
        await sbx.kill();
      }
    });
  },
);
