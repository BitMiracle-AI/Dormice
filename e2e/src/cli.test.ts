import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Dormice } from '@dormice/sdk';
import { describe, expect, inject, it } from 'vitest';

const run = promisify(execFile);

// The CLI exactly the way a user runs it: the built binary in a child
// process, configured only through environment variables.
const CLI = fileURLToPath(
  new URL('../../packages/cli/dist/main.js', import.meta.url),
);

if (!existsSync(CLI)) {
  throw new Error(`CLI build not found at ${CLI} — run \`pnpm build\` first`);
}

function cli(...args: string[]) {
  return run('node', [CLI, ...args], {
    env: {
      ...process.env,
      DORMICE_ENDPOINT: inject('dormiceEndpoint'),
      DORMICE_API_TOKEN: inject('dormiceToken'),
    },
  });
}

describe('dor CLI against a real daemon', () => {
  it('sandbox ls shows a sandbox acquired through the SDK', async () => {
    const sdk = new Dormice({
      endpoint: inject('dormiceEndpoint'),
      token: inject('dormiceToken'),
    });
    const created = await sdk.acquireSandbox('cli-ls-key');

    const { stdout } = await cli('sandbox', 'ls');
    expect(stdout).toMatch(/NAME\s{2,}STATE\s{2,}ID/);
    expect(stdout).toMatch(/cli-ls-key\s{2,}active/);
    expect(stdout).toContain(created.sandbox.id);
  });

  it('sandbox meta shows, replaces and clears labels through the real binary', async () => {
    const sdk = new Dormice({
      endpoint: inject('dormiceEndpoint'),
      token: inject('dormiceToken'),
    });
    await sdk.acquireSandbox('cli-meta-key', {
      metadata: { app: 'crawler', env: 'prod' },
    });

    // ls renders the labels in the METADATA column.
    const listed = await cli('sandbox', 'ls');
    expect(listed.stdout).toMatch(/METADATA/);
    expect(listed.stdout).toContain('app=crawler,env=prod');

    const shown = await cli('sandbox', 'meta', 'cli-meta-key');
    expect(shown.stdout).toBe('app=crawler,env=prod\n');

    const replaced = await cli('sandbox', 'meta', 'cli-meta-key', 'app=ci');
    expect(replaced.stdout).toContain('is now app=ci.');

    const cleared = await cli('sandbox', 'meta', 'cli-meta-key', '--clear');
    expect(cleared.stdout).toContain('Cleared metadata');
    const empty = await cli('sandbox', 'meta', 'cli-meta-key');
    expect(empty.stdout).toBe('No metadata.\n');

    // A word that is not key=value is named in the error, before any RPC.
    await expect(
      cli('sandbox', 'meta', 'cli-meta-key', 'not-a-label'),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('not key=value'),
    });
  });

  it('sandbox destroy destroys and is idempotent', async () => {
    const sdk = new Dormice({
      endpoint: inject('dormiceEndpoint'),
      token: inject('dormiceToken'),
    });
    await sdk.acquireSandbox('cli-destroy-key');

    const first = await cli('sandbox', 'destroy', 'cli-destroy-key');
    expect(first.stdout).toContain('Destroyed the sandbox');
    const second = await cli('sandbox', 'destroy', 'cli-destroy-key');
    expect(second.stdout).toContain('nothing to destroy');
  });

  it('sandbox exec prints the output and passes the exit code through', async () => {
    const sdk = new Dormice({
      endpoint: inject('dormiceEndpoint'),
      token: inject('dormiceToken'),
    });
    await sdk.acquireSandbox('cli-exec-key');

    const ok = await cli('sandbox', 'exec', 'cli-exec-key', 'echo hi');
    expect(ok.stdout).toBe('hi\n');

    // execFile rejects on a nonzero child exit — which is exactly the
    // passthrough working: the sandbox command's code became dor's own.
    await expect(
      cli('sandbox', 'exec', 'cli-exec-key', 'exit 3'),
    ).rejects.toMatchObject({ code: 3 });
  });

  it('sandbox push and pull move a file in and back out through the real binary', async () => {
    const sdk = new Dormice({
      endpoint: inject('dormiceEndpoint'),
      token: inject('dormiceToken'),
    });
    await sdk.acquireSandbox('cli-files-key');
    const local = path.join(
      await mkdtemp(path.join(tmpdir(), 'dor-e2e-')),
      'in.txt',
    );
    await writeFile(local, 'through the CLI\n');

    const pushed = await cli('sandbox', 'push', 'cli-files-key', local);
    // No remotePath given: the local file name lands under /home/user.
    expect(pushed.stdout).toContain('Wrote /home/user/in.txt (16 bytes).');

    // No localPath given: raw bytes to stdout, untouched.
    const pulled = await cli('sandbox', 'pull', 'cli-files-key', 'in.txt');
    expect(pulled.stdout).toBe('through the CLI\n');
  });

  it('template add, ls and rm run the registration life through the real binary', async () => {
    const added = await cli('template', 'add', 'cli-tpl', 'img:cli');
    expect(added.stdout).toContain('Registered template "cli-tpl" -> img:cli.');

    const listed = await cli('template', 'ls');
    expect(listed.stdout).toMatch(/NAME\s{2,}IMAGE\s{2,}CREATED/);
    expect(listed.stdout).toMatch(/cli-tpl\s{2,}img:cli/);

    const removed = await cli('template', 'rm', 'cli-tpl');
    expect(removed.stdout).toContain('Removed template "cli-tpl".');
    const again = await cli('template', 'rm', 'cli-tpl');
    expect(again.stdout).toContain('nothing to remove');
  });

  it('apikey create, ls and revoke run the rotation life through the real binary', async () => {
    const created = await cli('apikey', 'create', 'cli-key');
    const lines = created.stdout.trim().split('\n');
    expect(lines[0]).toMatch(
      /^Created API key "cli-key" \(prefix [0-9a-f]{8}\)\./,
    );
    const token = lines[1] ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[2]).toContain('never be shown again');

    // The minted key IS a DORMICE_API_TOKEN — same variable, new value:
    // exactly what rotation looks like from a client's shell.
    const keyed = await run('node', [CLI, 'sandbox', 'ls'], {
      env: {
        ...process.env,
        DORMICE_ENDPOINT: inject('dormiceEndpoint'),
        DORMICE_API_TOKEN: token,
      },
    });
    expect(keyed.stdout).toBeDefined();

    const listed = await cli('apikey', 'ls');
    expect(listed.stdout).toMatch(/NAME\s{2,}PREFIX\s{2,}CREATED/);
    expect(listed.stdout).toMatch(/cli-key\s{2,}[0-9a-f]{8}.*active/);

    const revoked = await cli('apikey', 'revoke', 'cli-key');
    expect(revoked.stdout).toContain('Revoked API key "cli-key"');
    await expect(
      run('node', [CLI, 'sandbox', 'ls'], {
        env: {
          ...process.env,
          DORMICE_ENDPOINT: inject('dormiceEndpoint'),
          DORMICE_API_TOKEN: token,
        },
      }),
    ).rejects.toMatchObject({ code: 1 });
    const again = await cli('apikey', 'revoke', 'cli-key');
    expect(again.stdout).toContain('nothing to revoke');
  });

  it('fails honestly when the environment is missing', async () => {
    await expect(
      run('node', [CLI, 'sandbox', 'ls'], {
        // Empty strings are falsy: this wipes any DORMICE_* the developer's
        // own shell might carry.
        env: { ...process.env, DORMICE_ENDPOINT: '', DORMICE_API_TOKEN: '' },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('DORMICE_ENDPOINT and DORMICE_API_TOKEN'),
    });
  });
});
