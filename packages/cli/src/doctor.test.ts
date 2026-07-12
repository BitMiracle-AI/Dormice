import { describe, expect, it } from 'vitest';
import {
  type CheckResult,
  type DoctorContext,
  type RunResult,
  runDoctor,
} from './doctor';

const IMAGE = 'dormice-base:20260708';
const TOKEN = 'a'.repeat(64);

const ok = (stdout: string): RunResult => ({ ok: true, stdout, stderr: '' });
const boom = (stderr: string): RunResult => ({ ok: false, stdout: '', stderr });

const GOOD_DAEMON_JSON = JSON.stringify({
  'registry-mirrors': [],
  'log-driver': 'json-file',
  'log-opts': { 'max-size': '10m', 'max-file': '3' },
  icc: false,
});

const IPTABLES_GOOD = [
  '-N DOCKER-USER',
  '-A DOCKER-USER -d 100.100.100.200/32 -j DROP',
  '-A DOCKER-USER -d 169.254.0.0/16 -j DROP',
  '-A DOCKER-USER -j RETURN',
].join('\n');

const DF_ROOMY =
  'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
  '/dev/vda3 200000000 50000000 150000000 25% /';

/**
 * A whole healthy host, faked. Tests override single facts to break one
 * check at a time — the doctor equivalent of the contract suite's "one
 * behavior per question".
 */
function fakeHost(
  overrides: {
    platform?: string;
    nodeVersion?: string;
    uid?: number;
    env?: Record<string, string | undefined>;
    files?: Record<string, string | undefined>;
    commands?: Record<string, RunResult>;
  } = {},
): DoctorContext & { calls: string[] } {
  const files: Record<string, string | undefined> = {
    '/sys/fs/cgroup/cgroup.controllers': 'cpuset cpu io memory pids',
    '/etc/docker/daemon.json': GOOD_DAEMON_JSON,
    '/proc/meminfo': 'MemTotal: 30000000 kB\nSwapTotal: 16777212 kB',
    '/proc/sys/vm/swappiness': '100\n',
    '/etc/iptables/rules.v4': IPTABLES_GOOD,
    '/etc/caddy/Caddyfile':
      '# Managed by Dormice — setIngress rewrites this file.\n\n:80 {\n\treverse_proxy 127.0.0.1:3676\n}\n',
    ...overrides.files,
  };
  const commands: Record<string, RunResult> = {
    'docker version --format {{.Server.Version}}': ok('29.6.1\n'),
    'docker info --format {{json .Runtimes}}': ok(
      '{"runc":{"path":"runc"},"runsc":{"path":"/usr/local/bin/runsc"}}',
    ),
    'iptables -S DOCKER-USER': ok(IPTABLES_GOOD),
    [`docker image inspect ${IMAGE}`]: ok('[{}]'),
    'df -Pk /var/lib/dormice': ok(DF_ROOMY),
    [`docker run --rm --runtime=runsc ${IMAGE} uname -r`]:
      ok('4.19.0-gvisor\n'),
    [`docker run --rm --runtime=runsc ${IMAGE} bash -c timeout 3 bash -c "</dev/tcp/100.100.100.200/80" && echo LEAK || echo BLOCKED`]:
      ok('BLOCKED\n'),
    [`docker run --rm --runtime=runsc ${IMAGE} id -u`]: ok('1000\n'),
    [`docker run --rm --runtime=runsc ${IMAGE} bash -c command -v inotifywait || echo MISSING`]:
      ok('/usr/bin/inotifywait\n'),
    'zstd --version': ok('zstd command line interface v1.5.5\n'),
    'caddy version': ok('v2.10.0 h1:fakehash\n'),
    'systemctl is-active caddy': ok('active\n'),
    ...overrides.commands,
  };
  const calls: string[] = [];
  return {
    platform: overrides.platform ?? 'linux',
    nodeVersion: overrides.nodeVersion ?? 'v24.18.0',
    uid: overrides.uid ?? 0,
    env: overrides.env ?? {
      DORMICE_API_TOKEN: TOKEN,
      DORMICE_EXECUTOR: 'docker',
      DORMICE_BASE_IMAGE: IMAGE,
      DORMICE_DB_PATH: '/var/lib/dormice/dormice.db',
      DORMICE_DATA_DIR: '/var/lib/dormice',
      DORMICE_S3_ENDPOINT: 'http://127.0.0.1:9000',
      DORMICE_S3_BUCKET: 'dormice-archive',
      DORMICE_S3_ACCESS_KEY_ID: 'minio-user',
      DORMICE_S3_SECRET_ACCESS_KEY: 'minio-secret',
      DORMICE_INGRESS_FILE: '/etc/caddy/Caddyfile',
    },
    calls,
    run: async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      return commands[key] ?? boom(`fake host: no answer for "${key}"`);
    },
    readTextFile: async (path) => files[path],
  };
}

const statusOf = (results: Record<string, CheckResult>, id: string) =>
  results[id]?.status;

describe('runDoctor on a healthy host', () => {
  it('passes everything and declares the host ready', async () => {
    const { results, report, failed } = await runDoctor(fakeHost());
    expect(failed).toBe(false);
    const statuses = new Set(
      Object.values(results).map((result) => result.status),
    );
    expect(statuses).toEqual(new Set(['pass']));
    expect(report).toContain('This host looks ready');
  });

  it('--quick skips the probes without starting any container', async () => {
    const ctx = fakeHost();
    const { results, failed } = await runDoctor(ctx, { quick: true });
    expect(failed).toBe(false);
    expect(statusOf(results, 'probe-gvisor')).toBe('skip');
    expect(statusOf(results, 'probe-metadata')).toBe('skip');
    expect(statusOf(results, 'probe-image-user')).toBe('skip');
    expect(statusOf(results, 'probe-image-inotify')).toBe('skip');
    expect(ctx.calls.filter((call) => call.includes('docker run'))).toEqual([]);
  });

  it('a pre-watch image without inotifywait warns and points at the rebuild', async () => {
    const { results, failed } = await runDoctor(
      fakeHost({
        commands: {
          [`docker run --rm --runtime=runsc ${IMAGE} bash -c command -v inotifywait || echo MISSING`]:
            ok('MISSING\n'),
        },
      }),
    );
    // A warn: everything except E2B watch still works on the old image.
    expect(failed).toBe(false);
    expect(statusOf(results, 'probe-image-inotify')).toBe('warn');
    expect(results['probe-image-inotify']?.fix).toContain('images/Dockerfile');
  });
});

describe('platform gating', () => {
  it('on macOS only the platform-independent checks run', async () => {
    const { results, failed } = await runDoctor(
      fakeHost({ platform: 'darwin' }),
    );
    expect(failed).toBe(true);
    expect(statusOf(results, 'os-linux')).toBe('fail');
    expect(statusOf(results, 'node-version')).toBe('pass');
    expect(statusOf(results, 'api-token')).toBe('pass');
    expect(statusOf(results, 'docker-daemon')).toBe('skip');
    expect(statusOf(results, 'probe-gvisor')).toBe('skip');
  });

  it('without root, the iptables checks are skipped, not falsely red', async () => {
    const { results } = await runDoctor(fakeHost({ uid: 1000 }));
    expect(statusOf(results, 'root')).toBe('fail');
    expect(statusOf(results, 'metadata-firewall')).toBe('skip');
    expect(statusOf(results, 'metadata-persisted')).toBe('skip');
  });
});

describe('freezing prerequisites', () => {
  it('flags a wrong effective swappiness with the sysctl.d fix', async () => {
    // The Alibaba Cloud factory setting: their own sysctl.d file ships 0.
    const { results, report, failed } = await runDoctor(
      fakeHost({ files: { '/proc/sys/vm/swappiness': '0\n' } }),
    );
    expect(failed).toBe(true);
    expect(results.swappiness).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('99-dormice.conf'),
    });
    expect(report).toContain('effective value is 0');
  });

  it('flags a swapless host as a freezing failure', async () => {
    const { results } = await runDoctor(
      fakeHost({ files: { '/proc/meminfo': 'SwapTotal: 0 kB' } }),
    );
    expect(results.swap).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('nowhere to push'),
    });
  });
});

describe('docker configuration', () => {
  it('a missing daemon.json fails both icc and log rotation', async () => {
    const { results } = await runDoctor(
      fakeHost({ files: { '/etc/docker/daemon.json': undefined } }),
    );
    expect(statusOf(results, 'icc-disabled')).toBe('fail');
    expect(statusOf(results, 'log-rotation')).toBe('fail');
  });

  it('accepts the "local" log driver, which rotates by default', async () => {
    const { results } = await runDoctor(
      fakeHost({
        files: {
          '/etc/docker/daemon.json': JSON.stringify({
            icc: false,
            'log-driver': 'local',
          }),
        },
      }),
    );
    expect(statusOf(results, 'log-rotation')).toBe('pass');
  });
});

describe('metadata firewall', () => {
  it('names the exact missing DROP rule', async () => {
    const { results } = await runDoctor(
      fakeHost({
        commands: {
          'iptables -S DOCKER-USER': ok(
            '-N DOCKER-USER\n-A DOCKER-USER -d 169.254.0.0/16 -j DROP',
          ),
        },
      }),
    );
    expect(results['metadata-firewall']).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('100.100.100.200'),
    });
  });

  it('rules present but not persisted is a warning, not a failure', async () => {
    const { results, failed } = await runDoctor(
      fakeHost({ files: { '/etc/iptables/rules.v4': undefined } }),
    );
    expect(results['metadata-persisted']).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('iptables-persistent'),
    });
    // Warnings alone never flip the exit code.
    expect(failed).toBe(false);
  });
});

describe('daemon configuration', () => {
  it('a missing token warns, a short token fails', async () => {
    const unset = await runDoctor(
      fakeHost({ env: { DORMICE_EXECUTOR: 'fake' } }),
    );
    expect(statusOf(unset.results, 'api-token')).toBe('warn');

    const short = await runDoctor(
      fakeHost({
        env: { DORMICE_API_TOKEN: 'too-short', DORMICE_EXECUTOR: 'fake' },
      }),
    );
    expect(short.results['api-token']).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('9 characters'),
    });
  });

  it('docker mode with the default relative DB path fails ahead of the daemon', async () => {
    const { results } = await runDoctor(
      fakeHost({
        env: {
          DORMICE_API_TOKEN: TOKEN,
          DORMICE_EXECUTOR: 'docker',
          DORMICE_BASE_IMAGE: IMAGE,
          DORMICE_DATA_DIR: '/var/lib/dormice',
          // DORMICE_DB_PATH unset: the default is relative.
        },
      }),
    );
    expect(results['absolute-paths']).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('DORMICE_DB_PATH=data/dormice.db'),
    });
  });

  it('without a base image, image check and probes skip with directions', async () => {
    const { results, failed } = await runDoctor(
      fakeHost({ env: { DORMICE_API_TOKEN: TOKEN } }),
    );
    expect(results['base-image']).toMatchObject({
      status: 'skip',
      detail: expect.stringContaining('DORMICE_BASE_IMAGE'),
    });
    expect(statusOf(results, 'probe-gvisor')).toBe('skip');
    expect(statusOf(results, 'absolute-paths')).toBe('skip');
    expect(failed).toBe(false);
  });

  it('scarce disk space warns with the measured number', async () => {
    const { results } = await runDoctor(
      fakeHost({
        commands: {
          'df -Pk /var/lib/dormice': ok(
            'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
              '/dev/vda3 200000000 195000000 5242880 98% /',
          ),
        },
      }),
    );
    expect(results['disk-space']).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('5.0 GiB'),
    });
  });
});

describe('container probes', () => {
  it('a real host kernel in the probe means gVisor is not isolating', async () => {
    const { results, failed } = await runDoctor(
      fakeHost({
        commands: {
          [`docker run --rm --runtime=runsc ${IMAGE} uname -r`]: ok(
            '6.8.0-124-generic\n',
          ),
        },
      }),
    );
    expect(failed).toBe(true);
    expect(results['probe-gvisor']).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('6.8.0-124-generic'),
    });
  });

  it('LEAK from the metadata probe is a hard failure with the iptables fix', async () => {
    const { results } = await runDoctor(
      fakeHost({
        commands: {
          [`docker run --rm --runtime=runsc ${IMAGE} bash -c timeout 3 bash -c "</dev/tcp/100.100.100.200/80" && echo LEAK || echo BLOCKED`]:
            ok('LEAK\n'),
        },
      }),
    );
    expect(results['probe-metadata']).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('DOCKER-USER'),
    });
  });

  it('a root image fails the uid probe', async () => {
    const { results } = await runDoctor(
      fakeHost({
        commands: {
          [`docker run --rm --runtime=runsc ${IMAGE} id -u`]: ok('0\n'),
        },
      }),
    );
    expect(results['probe-image-user']).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('uid 0'),
    });
  });
});

describe('the ingress check', () => {
  it('skips when the daemon manages no proxy', async () => {
    const ctx = fakeHost({ env: { DORMICE_API_TOKEN: TOKEN } });
    const { results } = await runDoctor(ctx, { quick: true });
    expect(results.ingress).toMatchObject({
      status: 'skip',
      detail: expect.stringContaining('DORMICE_INGRESS_FILE'),
    });
  });

  it('fails when the knob is set but caddy is missing or stopped', async () => {
    const noBinary = await runDoctor(
      fakeHost({ commands: { 'caddy version': boom('not found') } }),
      { quick: true },
    );
    expect(noBinary.results.ingress).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('caddy binary is missing'),
    });

    const stopped = await runDoctor(
      fakeHost({ commands: { 'systemctl is-active caddy': boom('inactive') } }),
      { quick: true },
    );
    expect(stopped.results.ingress).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('systemctl start caddy'),
    });
  });

  it('warns on a config file Dormice does not own', async () => {
    const { results } = await runDoctor(
      fakeHost({
        files: {
          '/etc/caddy/Caddyfile': 'example.org {\n\trespond "mine"\n}\n',
        },
      }),
      { quick: true },
    );
    expect(results.ingress).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('not written by Dormice'),
    });
  });

  it('reports the bound domain from the managed file', async () => {
    const { results } = await runDoctor(
      fakeHost({
        files: {
          '/etc/caddy/Caddyfile':
            '# Managed by Dormice — setIngress rewrites this file.\n\nconsole.example.com {\n\treverse_proxy 127.0.0.1:3676\n}\n\n:80 {\n\treverse_proxy 127.0.0.1:3676\n}\n',
        },
      }),
      { quick: true },
    );
    expect(results.ingress).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('domain console.example.com'),
    });
  });
});

describe('the S3 archive checks', () => {
  // fakeHost's env override replaces wholesale; this is the healthy host's
  // env WITHOUT the S3 set — the archiver-less operator.
  const NO_S3_ENV = {
    DORMICE_API_TOKEN: TOKEN,
    DORMICE_EXECUTOR: 'docker',
    DORMICE_BASE_IMAGE: IMAGE,
    DORMICE_DB_PATH: '/var/lib/dormice/dormice.db',
    DORMICE_DATA_DIR: '/var/lib/dormice',
  };

  it('skips both checks when no S3 is configured', async () => {
    const { results, failed } = await runDoctor(fakeHost({ env: NO_S3_ENV }));
    expect(results['s3-config']).toMatchObject({
      status: 'skip',
      detail: expect.stringContaining('archiver is disabled'),
    });
    // zstd is gated on s3-config passing, and skips are not failures.
    expect(results.zstd).toMatchObject({ status: 'skip' });
    expect(failed).toBe(false);
  });

  it('fails a partial S3 set, naming the missing variables', async () => {
    const { results } = await runDoctor(
      fakeHost({
        env: {
          ...NO_S3_ENV,
          DORMICE_S3_ENDPOINT: 'http://127.0.0.1:9000',
          DORMICE_S3_BUCKET: 'dormice-archive',
        },
      }),
    );
    expect(results['s3-config']).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('DORMICE_S3_ACCESS_KEY_ID'),
    });
  });

  it('passes a full set and checks zstd on the docker executor', async () => {
    // The healthy default host carries the full S3 set and zstd.
    const { results } = await runDoctor(fakeHost());
    expect(results['s3-config']).toMatchObject({ status: 'pass' });
    expect(results.zstd).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('zstd'),
    });
  });

  it('fails when zstd is missing on a docker host with S3 configured', async () => {
    const { results } = await runDoctor(
      fakeHost({ commands: { 'zstd --version': boom('not found') } }),
    );
    expect(results.zstd).toMatchObject({
      status: 'fail',
      fix: 'apt-get install -y zstd',
    });
  });
});
