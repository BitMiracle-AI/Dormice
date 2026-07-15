import { describe, expect, it } from 'vitest';
import { loadConfig, s3Settings } from './config';

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
});

describe('the S3 set', () => {
  const S3 = {
    DORMICE_S3_ENDPOINT: 'http://127.0.0.1:9000',
    DORMICE_S3_BUCKET: 'dormice-archive',
    DORMICE_S3_ACCESS_KEY_ID: 'minio-user',
    DORMICE_S3_SECRET_ACCESS_KEY: 'minio-secret',
  };

  it('parses a full set and adjudicates the archiver as configured', () => {
    const config = loadConfig({ ...TOKEN, ...S3 });
    expect(s3Settings(config)).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'dormice-archive',
      accessKeyId: 'minio-user',
      secretAccessKey: 'minio-secret',
      region: 'us-east-1',
      forcePathStyle: false,
    });
  });

  it('adjudicates the archiver as absent when nothing is set', () => {
    expect(s3Settings(loadConfig(TOKEN))).toBeNull();
  });

  it('refuses a partial set, naming exactly the missing variables', () => {
    expect(() =>
      loadConfig({
        ...TOKEN,
        DORMICE_S3_ENDPOINT: 'http://127.0.0.1:9000',
        DORMICE_S3_BUCKET: 'dormice-archive',
      }),
    ).toThrow(
      /DORMICE_S3_ACCESS_KEY_ID, DORMICE_S3_SECRET_ACCESS_KEY are missing/,
    );
  });

  it('rejects an endpoint without a scheme', () => {
    expect(() =>
      loadConfig({ ...TOKEN, ...S3, DORMICE_S3_ENDPOINT: 's3.example.com' }),
    ).toThrow(/DORMICE_S3_ENDPOINT must be a full http\(s\) URL/);
  });

  it('parses the path-style knob as a real boolean', () => {
    // The z.coerce.boolean trap: the string "false" must not become true.
    const on = loadConfig({
      ...TOKEN,
      ...S3,
      DORMICE_S3_FORCE_PATH_STYLE: 'true',
    });
    expect(on.DORMICE_S3_FORCE_PATH_STYLE).toBe(true);
    const off = loadConfig({
      ...TOKEN,
      ...S3,
      DORMICE_S3_FORCE_PATH_STYLE: 'false',
    });
    expect(off.DORMICE_S3_FORCE_PATH_STYLE).toBe(false);
  });
});
