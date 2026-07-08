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

  it('accepts the docker executor with a base image and absolute paths', () => {
    const config = loadConfig({
      ...TOKEN,
      DORMICE_EXECUTOR: 'docker',
      DORMICE_BASE_IMAGE: 'dormice-base:20260708',
      DORMICE_DB_PATH: '/var/lib/dormice/dormice.db',
    });
    expect(config.DORMICE_EXECUTOR).toBe('docker');
    expect(config.DORMICE_DATA_DIR).toBe('/var/lib/dormice');
    expect(config.DORMICE_SANDBOX_DISK_GB).toBe(10);
  });

  it('rejects a relative DB path in docker mode', () => {
    // The default DB path is relative (dev-friendly for the fake executor);
    // docker mode manages real sandboxes and must not depend on the start
    // directory — a wrong one opens an empty ledger next to real data.
    expect(() =>
      loadConfig({
        ...TOKEN,
        DORMICE_EXECUTOR: 'docker',
        DORMICE_BASE_IMAGE: 'dormice-base:20260708',
      }),
    ).toThrow(/DORMICE_DB_PATH must be an absolute path/);
  });

  it('rejects a relative data dir in docker mode', () => {
    expect(() =>
      loadConfig({
        ...TOKEN,
        DORMICE_EXECUTOR: 'docker',
        DORMICE_BASE_IMAGE: 'dormice-base:20260708',
        DORMICE_DB_PATH: '/var/lib/dormice/dormice.db',
        DORMICE_DATA_DIR: 'data/disks',
      }),
    ).toThrow(/DORMICE_DATA_DIR must be an absolute path/);
  });

  it('keeps the relative default for the fake executor', () => {
    expect(loadConfig(TOKEN).DORMICE_DB_PATH).toBe('data/dormice.db');
  });
});
