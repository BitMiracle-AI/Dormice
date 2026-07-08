import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { Dormice } from '@dormice/sdk';
import { describe, expect, inject, it } from 'vitest';

const run = promisify(execFile);

// The CLI exactly the way a user runs it: the built binary in a child
// process, configured only through environment variables.
const CLI = new URL('../../packages/cli/dist/main.js', import.meta.url)
  .pathname;

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
    expect(stdout).toMatch(/USER KEY\s{2,}STATE\s{2,}SANDBOX ID/);
    expect(stdout).toMatch(/cli-ls-key\s{2,}active/);
    expect(stdout).toContain(created.sandbox.sandboxId);
  });

  it('sandbox release destroys and is idempotent', async () => {
    const sdk = new Dormice({
      endpoint: inject('dormiceEndpoint'),
      token: inject('dormiceToken'),
    });
    await sdk.acquireSandbox('cli-release-key');

    const first = await cli('sandbox', 'release', 'cli-release-key');
    expect(first.stdout).toContain('Released the sandbox');
    const second = await cli('sandbox', 'release', 'cli-release-key');
    expect(second.stdout).toContain('nothing to release');
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
