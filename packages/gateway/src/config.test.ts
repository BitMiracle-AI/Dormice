import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const TOKEN = { DORMICE_API_TOKEN: 'x'.repeat(32) };

describe('loadConfig', () => {
  it('defaults: port 3677, an absolute database path, placement knobs 70% / 400 active / 10 GiB', () => {
    const config = loadConfig(TOKEN);
    expect(config.DORMICE_GATEWAY_PORT).toBe(3677);
    expect(config.DORMICE_GATEWAY_DB_PATH).toBe(
      '/var/lib/dormice-gateway/gateway.db',
    );
    expect(config.DORMICE_GATEWAY_NODE_CPU_LIMIT_PCT).toBe(70);
    expect(config.DORMICE_GATEWAY_NODE_ACTIVE_LIMIT).toBe(400);
    expect(config.DORMICE_GATEWAY_NODE_MIN_DISK_GB).toBe(10);
    expect(config.DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS).toBe(30);
  });

  it('requires the fleet token, at least 32 characters, naming the variable', () => {
    expect(() => loadConfig({})).toThrow(/DORMICE_API_TOKEN/);
    expect(() => loadConfig({ DORMICE_API_TOKEN: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('refuses a relative database path and accepts :memory:', () => {
    expect(() =>
      loadConfig({ ...TOKEN, DORMICE_GATEWAY_DB_PATH: 'data/gateway.db' }),
    ).toThrow(/DORMICE_GATEWAY_DB_PATH must be an absolute path/);
    expect(
      loadConfig({ ...TOKEN, DORMICE_GATEWAY_DB_PATH: ':memory:' })
        .DORMICE_GATEWAY_DB_PATH,
    ).toBe(':memory:');
  });

  it('parses the placement knobs and refuses nonsense', () => {
    const config = loadConfig({
      ...TOKEN,
      DORMICE_GATEWAY_NODE_CPU_LIMIT_PCT: '85',
      DORMICE_GATEWAY_NODE_ACTIVE_LIMIT: '2',
      DORMICE_GATEWAY_NODE_MIN_DISK_GB: '0.5',
    });
    expect(config.DORMICE_GATEWAY_NODE_CPU_LIMIT_PCT).toBe(85);
    expect(config.DORMICE_GATEWAY_NODE_ACTIVE_LIMIT).toBe(2);
    expect(config.DORMICE_GATEWAY_NODE_MIN_DISK_GB).toBe(0.5);
    expect(() =>
      loadConfig({ ...TOKEN, DORMICE_GATEWAY_NODE_CPU_LIMIT_PCT: '101' }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...TOKEN, DORMICE_GATEWAY_NODE_ACTIVE_LIMIT: '0' }),
    ).toThrow();
    expect(
      loadConfig({ ...TOKEN, DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS: '1' })
        .DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS,
    ).toBe(1);
    expect(() =>
      loadConfig({ ...TOKEN, DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS: '0' }),
    ).toThrow();
  });
});
