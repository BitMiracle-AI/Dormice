import { describe, expect, it } from 'vitest';
import { ignoredEnvKeys, loadConfig, MOVED_TO_GATEWAY } from './config';

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

describe('the metrics sampler knobs', () => {
  it('defaults: 30s interval, 168h retention', () => {
    const config = loadConfig(TOKEN);
    expect(config.DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS).toBe(30);
    expect(config.DORMICE_METRICS_RETENTION_HOURS).toBe(168);
  });

  it('parses overrides and rejects a non-positive interval', () => {
    const config = loadConfig({
      ...TOKEN,
      DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS: '5',
      DORMICE_METRICS_RETENTION_HOURS: '24',
    });
    expect(config.DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS).toBe(5);
    expect(config.DORMICE_METRICS_RETENTION_HOURS).toBe(24);
    expect(() =>
      loadConfig({ ...TOKEN, DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS: '0' }),
    ).toThrow();
  });

  it('refuses an interval past a day on every ticker knob — past 2^31-1 ms Node would fire it every millisecond instead', () => {
    for (const knob of [
      'DORMICE_SCAN_INTERVAL_SECONDS',
      'DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS',
      'DORMICE_CHECK_IN_INTERVAL_SECONDS',
    ]) {
      const atTheCeiling = loadConfig({ ...TOKEN, [knob]: '86400' }) as Record<
        string,
        unknown
      >;
      expect(atTheCeiling[knob]).toBe(86_400);
      expect(() => loadConfig({ ...TOKEN, [knob]: '86401' })).toThrow();
    }
  });
});

describe('the knobs that moved to the gateway', () => {
  it('are not knobs here: the config has no field for them, and the boot line can name the ones an env file still carries', () => {
    const config = loadConfig({
      ...TOKEN,
      DORMICE_SANDBOX_DISK_GB: '20',
      DORMICE_S3_ENDPOINT: 'http://127.0.0.1:9000',
    });
    expect(Object.keys(config)).not.toContain('DORMICE_SANDBOX_DISK_GB');
    expect(Object.keys(config)).not.toContain('DORMICE_S3_ENDPOINT');
    expect(
      ignoredEnvKeys({
        ...TOKEN,
        DORMICE_SANDBOX_DISK_GB: '20',
        DORMICE_S3_ENDPOINT: 'http://127.0.0.1:9000',
        DORMICE_PORT: '3676',
      }),
    ).toEqual(['DORMICE_SANDBOX_DISK_GB', 'DORMICE_S3_ENDPOINT']);
    expect(ignoredEnvKeys(TOKEN)).toEqual([]);
    // Thirteen names, every one an old daemon variable and none of them a knob the node still has.
    expect(MOVED_TO_GATEWAY).toHaveLength(13);
    for (const key of MOVED_TO_GATEWAY) {
      expect(Object.keys(loadConfig(TOKEN))).not.toContain(key);
    }
  });
});

describe('the fleet knobs: gateway, node endpoint, check-in interval', () => {
  it('defaults: the gateway beside the daemon (a fleet of one), no node endpoint, 15s check-in', () => {
    const config = loadConfig(TOKEN);
    expect(config.DORMICE_GATEWAY_ENDPOINT).toBe('http://127.0.0.1:3677');
    expect(config.DORMICE_NODE_ENDPOINT).toBeUndefined();
    expect(config.DORMICE_CHECK_IN_INTERVAL_SECONDS).toBe(15);
  });

  it('parses both endpoints as full URLs and drops a trailing slash', () => {
    const config = loadConfig({
      ...TOKEN,
      DORMICE_GATEWAY_ENDPOINT: 'http://10.0.0.5:3677/',
      DORMICE_NODE_ENDPOINT: 'http://10.0.0.7:80///',
      DORMICE_NODE_ID: 'node-7',
      DORMICE_CHECK_IN_INTERVAL_SECONDS: '5',
    });
    expect(config.DORMICE_GATEWAY_ENDPOINT).toBe('http://10.0.0.5:3677');
    expect(config.DORMICE_NODE_ENDPOINT).toBe('http://10.0.0.7:80');
    expect(config.DORMICE_CHECK_IN_INTERVAL_SECONDS).toBe(5);
  });

  it('refuses an endpoint without a scheme, naming the variable', () => {
    expect(() =>
      loadConfig({ ...TOKEN, DORMICE_GATEWAY_ENDPOINT: '10.0.0.5:3677' }),
    ).toThrow(/DORMICE_GATEWAY_ENDPOINT must be a full http\(s\) URL/);
    expect(() =>
      loadConfig({ ...TOKEN, DORMICE_NODE_ENDPOINT: 'node-7' }),
    ).toThrow(/DORMICE_NODE_ENDPOINT must be a full http\(s\) URL/);
    expect(() =>
      loadConfig({ ...TOKEN, DORMICE_CHECK_IN_INTERVAL_SECONDS: '0' }),
    ).toThrow();
  });

  it('a node endpoint with a path or a query is refused at boot, naming why; a trailing slash is still just dropped', () => {
    expect(() =>
      loadConfig({
        ...TOKEN,
        DORMICE_GATEWAY_ENDPOINT: 'http://10.0.0.5:3677',
        DORMICE_NODE_ENDPOINT: 'http://10.0.0.7:80/dormice',
      }),
    ).toThrow(
      /DORMICE_NODE_ENDPOINT must name the node's front without a path/,
    );
    expect(() =>
      loadConfig({
        ...TOKEN,
        DORMICE_NODE_ENDPOINT: 'http://10.0.0.7:80/?x=1',
      }),
    ).toThrow(/without a path/);
    expect(
      loadConfig({ ...TOKEN, DORMICE_NODE_ENDPOINT: 'http://10.0.0.7:80/' })
        .DORMICE_NODE_ENDPOINT,
    ).toBe('http://10.0.0.7:80');
  });

  it('a gateway on another machine requires the node endpoint, naming why; a loopback gateway does not', () => {
    expect(() =>
      loadConfig({
        ...TOKEN,
        DORMICE_GATEWAY_ENDPOINT: 'http://10.0.0.5:3677',
      }),
    ).toThrow(
      /DORMICE_NODE_ENDPOINT is required when DORMICE_GATEWAY_ENDPOINT is not loopback/,
    );
    expect(
      loadConfig({
        ...TOKEN,
        DORMICE_GATEWAY_ENDPOINT: 'http://10.0.0.5:3677',
        DORMICE_NODE_ENDPOINT: 'http://10.0.0.7:80',
        DORMICE_NODE_ID: 'node-7',
      }).DORMICE_NODE_ENDPOINT,
    ).toBe('http://10.0.0.7:80');
    for (const local of [
      'http://127.0.0.1:3677',
      'http://localhost:3677',
      'http://[::1]:3677',
    ]) {
      expect(
        loadConfig({ ...TOKEN, DORMICE_GATEWAY_ENDPOINT: local })
          .DORMICE_NODE_ENDPOINT,
      ).toBeUndefined();
    }
  });

  it('a gateway on another machine requires a node id of its own, naming why; beside its gateway the default serves', () => {
    expect(() =>
      loadConfig({
        ...TOKEN,
        DORMICE_GATEWAY_ENDPOINT: 'http://10.0.0.5:3677',
        DORMICE_NODE_ENDPOINT: 'http://10.0.0.7:80',
      }),
    ).toThrow(
      /DORMICE_NODE_ID is required when DORMICE_GATEWAY_ENDPOINT is not loopback/,
    );
    expect(
      loadConfig({
        ...TOKEN,
        DORMICE_GATEWAY_ENDPOINT: 'http://10.0.0.5:3677',
        DORMICE_NODE_ENDPOINT: 'http://10.0.0.7:80',
        DORMICE_NODE_ID: 'bj-7',
      }).DORMICE_NODE_ID,
    ).toBe('bj-7');
    expect(
      loadConfig({
        ...TOKEN,
        DORMICE_GATEWAY_ENDPOINT: 'http://127.0.0.1:3677',
      }).DORMICE_NODE_ID,
    ).toBe('node-1');
    expect(loadConfig(TOKEN).DORMICE_NODE_ID).toBe('node-1');
  });
});
