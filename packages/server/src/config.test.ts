import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const TOKEN = { DORMICE_API_TOKEN: 'x'.repeat(32) };

describe('loadConfig executor knobs', () => {
  it('defaults to the fake executor', () => {
    expect(loadConfig(TOKEN).DORMICE_EXECUTOR).toBe('fake');
  });

  it('rejects the docker executor without a base image', () => {
    expect(() => loadConfig({ ...TOKEN, DORMICE_EXECUTOR: 'docker' })).toThrow(
      /DORMICE_BASE_IMAGE is required/,
    );
  });

  it('accepts the docker executor with a base image', () => {
    const config = loadConfig({
      ...TOKEN,
      DORMICE_EXECUTOR: 'docker',
      DORMICE_BASE_IMAGE: 'dormice-base:20260708',
    });
    expect(config.DORMICE_EXECUTOR).toBe('docker');
    expect(config.DORMICE_DATA_DIR).toBe('/var/lib/dormice');
    expect(config.DORMICE_SANDBOX_DISK_GB).toBe(10);
  });
});
