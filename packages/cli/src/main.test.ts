import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

describe('sandbox exec options', () => {
  it('rejects a non-numeric timeout at the option boundary', () => {
    const result = spawnSync(
      process.execPath,
      [cli, 'sandbox', 'exec', 'example', 'true', '--timeout', '10m'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DORMICE_ENDPOINT: 'http://127.0.0.1:1',
          DORMICE_API_TOKEN: 'test-token-test-token-test-token',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--timeout must be a positive integer of seconds',
    );
    expect(result.stderr).not.toContain('delay');
  });
});
