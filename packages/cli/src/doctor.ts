import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/**
 * `dor doctor` answers one question: can this host run the Dormice daemon?
 *
 * Every check below encodes a fact measured on a real machine (the pit
 * list), not a hypothesis. Two disciplines:
 *
 * - Read-only. Doctor names the fix but never applies it — a checker that
 *   quietly mutates the system is the "silent self-healing" the design
 *   rules forbid. Fixing is install.sh's job.
 * - Effective values over config files. The lesson: some clouds ship
 *   vm.swappiness=0 in their own sysctl.d file, so "our config file
 *   exists" proves nothing. Wherever the live value is readable, read it.
 */

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Everything a check may touch, injected so tests can fake a whole host.
 * Same discipline as FakeExecutor: the fake is the permanent test double,
 * the real machine is the final judge.
 */
export interface DoctorContext {
  platform: string;
  nodeVersion: string;
  uid: number | undefined;
  env: Record<string, string | undefined>;
  run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<RunResult>;
  /** undefined when the file is missing or unreadable. */
  readTextFile(path: string): Promise<string | undefined>;
}

export function realDoctorContext(): DoctorContext {
  return {
    platform: process.platform,
    nodeVersion: process.version,
    uid: process.getuid?.(),
    env: process.env,
    run: (cmd, args, opts) =>
      new Promise((resolve) => {
        execFile(
          cmd,
          args,
          // SIGKILL on timeout: a hung dockerd must not hang doctor too.
          {
            timeout: opts?.timeoutMs ?? 10_000,
            killSignal: 'SIGKILL',
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            resolve({
              ok: error === null,
              stdout,
              stderr: stderr || (error ? error.message : ''),
            });
          },
        );
      }),
    readTextFile: async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckResult {
  status: CheckStatus;
  detail: string;
  fix?: string;
}

interface DoctorCheck {
  id: string;
  title: string;
  /** Checks that must pass first; otherwise this one is skipped. */
  needs?: string[];
  /** Starts a real container — skipped by --quick. */
  probe?: boolean;
  run(ctx: DoctorContext): Promise<CheckResult>;
}

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const fail = (detail: string, fix?: string): CheckResult => ({
  status: 'fail',
  detail,
  fix,
});
const warn = (detail: string, fix?: string): CheckResult => ({
  status: 'warn',
  detail,
  fix,
});
const skip = (detail: string): CheckResult => ({ status: 'skip', detail });

const DAEMON_JSON = '/etc/docker/daemon.json';
const RULES_V4 = '/etc/iptables/rules.v4';
const METADATA_IP = '100.100.100.200';
const METADATA_RANGE = '169.254.0.0/16';

async function daemonJson(
  ctx: DoctorContext,
): Promise<Record<string, unknown> | undefined> {
  const text = await ctx.readTextFile(DAEMON_JSON);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const baseImage = (ctx: DoctorContext) => ctx.env.DORMICE_BASE_IMAGE;

const CHECKS: DoctorCheck[] = [
  {
    id: 'os-linux',
    title: 'operating system',
    run: async (ctx) =>
      ctx.platform === 'linux'
        ? pass('Linux')
        : fail(
            `the daemon needs Linux (loop mounts, cgroups, gVisor) — found "${ctx.platform}"`,
          ),
  },
  {
    id: 'node-version',
    title: 'Node.js version',
    run: async (ctx) => {
      const major = Number(ctx.nodeVersion.replace(/^v/, '').split('.')[0]);
      return major >= 22
        ? pass(`${ctx.nodeVersion} (>= 22)`)
        : fail(`${ctx.nodeVersion} is below the required Node 22`);
    },
  },
  {
    id: 'root',
    title: 'running as root',
    needs: ['os-linux'],
    run: async (ctx) =>
      ctx.uid === 0
        ? pass('uid 0')
        : fail(
            `running as uid ${ctx.uid ?? 'unknown'} — loop mounts, mkfs and cgroup writes need root`,
            'run doctor and the daemon as root',
          ),
  },
  {
    id: 'cgroup-v2',
    title: 'cgroup v2 memory controller',
    needs: ['os-linux'],
    run: async (ctx) => {
      const controllers = await ctx.readTextFile(
        '/sys/fs/cgroup/cgroup.controllers',
      );
      if (controllers === undefined) {
        return fail(
          'cgroup v2 unified hierarchy is not mounted — freezing needs memory.reclaim, a cgroup v2 file',
          'boot with systemd.unified_cgroup_hierarchy=1 (default on Ubuntu 22.04+)',
        );
      }
      return controllers.includes('memory')
        ? pass('memory controller available')
        : fail('cgroup v2 is mounted but the memory controller is missing');
    },
  },
  {
    id: 'docker-daemon',
    title: 'Docker daemon',
    needs: ['os-linux'],
    run: async (ctx) => {
      const res = await ctx.run('docker', [
        'version',
        '--format',
        '{{.Server.Version}}',
      ]);
      return res.ok
        ? pass(`server ${res.stdout.trim()}`)
        : fail(
            `dockerd is unreachable: ${res.stderr.trim()}`,
            'install Docker and start dockerd (https://docs.docker.com/engine/install/)',
          );
    },
  },
  {
    id: 'gvisor-runtime',
    title: 'gVisor runtime (runsc)',
    needs: ['docker-daemon'],
    run: async (ctx) => {
      const res = await ctx.run('docker', [
        'info',
        '--format',
        '{{json .Runtimes}}',
      ]);
      if (!res.ok) return fail(`docker info failed: ${res.stderr.trim()}`);
      return res.stdout.includes('"runsc"')
        ? pass('runsc registered as a Docker runtime')
        : fail(
            'runsc is not a registered Docker runtime — sandboxes would share the host kernel',
            'install gVisor, then `runsc install` and restart docker (https://gvisor.dev/docs/user_guide/install/)',
          );
    },
  },
  {
    id: 'icc-disabled',
    title: 'inter-container traffic off',
    needs: ['os-linux'],
    run: async (ctx) => {
      const config = await daemonJson(ctx);
      if (config === undefined) {
        return fail(
          `${DAEMON_JSON} is missing or not valid JSON — Docker defaults to icc: true, so one sandbox can scan another`,
          `set "icc": false in ${DAEMON_JSON} and restart docker`,
        );
      }
      return config.icc === false
        ? pass(`"icc": false in ${DAEMON_JSON}`)
        : fail(
            `"icc" is not false in ${DAEMON_JSON} — one sandbox can scan another`,
            `set "icc": false in ${DAEMON_JSON} and restart docker`,
          );
    },
  },
  {
    id: 'log-rotation',
    title: 'container log rotation',
    needs: ['os-linux'],
    run: async (ctx) => {
      const config = await daemonJson(ctx);
      const logOpts = config?.['log-opts'] as
        | Record<string, unknown>
        | undefined;
      // The "local" driver rotates by default; json-file needs max-size.
      if (config?.['log-driver'] === 'local' || logOpts?.['max-size']) {
        return pass(
          logOpts?.['max-size']
            ? `max-size ${logOpts['max-size']}`
            : 'log-driver "local" rotates by default',
        );
      }
      return fail(
        'container stdout logs grow without bound — a long-lived sandbox fills the disk over months',
        `set "log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"} in ${DAEMON_JSON} and restart docker`,
      );
    },
  },
  {
    id: 'swap',
    title: 'swap present',
    needs: ['os-linux'],
    run: async (ctx) => {
      const meminfo = (await ctx.readTextFile('/proc/meminfo')) ?? '';
      const kb = Number(/^SwapTotal:\s*(\d+) kB/m.exec(meminfo)?.[1] ?? 0);
      return kb > 0
        ? pass(`${(kb / 1024 / 1024).toFixed(1)} GiB`)
        : fail(
            'no swap — freezing has nowhere to push sandbox memory (measured: 0 bytes reclaimed without it)',
            "fallocate -l 16G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile, then add '/swapfile none swap sw 0 0' to /etc/fstab",
          );
    },
  },
  {
    id: 'swappiness',
    title: 'vm.swappiness = 100',
    needs: ['os-linux'],
    run: async (ctx) => {
      // The live value, on purpose: some clouds ship swappiness=0 in their
      // own sysctl.d file, so a config file existing proves nothing.
      const raw = await ctx.readTextFile('/proc/sys/vm/swappiness');
      const value = raw?.trim();
      if (value === undefined)
        return fail('cannot read /proc/sys/vm/swappiness');
      return value === '100'
        ? pass('100 (effective value)')
        : fail(
            `effective value is ${value} — below 100 the kernel refuses to swap gVisor's shmem-held sandbox memory (measured at 60: 0 bytes reclaimed)`,
            "echo 'vm.swappiness=100' > /etc/sysctl.d/99-dormice.conf && sysctl --system",
          );
    },
  },
  {
    id: 'metadata-firewall',
    title: 'cloud metadata firewall',
    needs: ['root', 'docker-daemon'],
    run: async (ctx) => {
      const res = await ctx.run('iptables', ['-S', 'DOCKER-USER']);
      if (!res.ok) {
        return fail(`cannot read the DOCKER-USER chain: ${res.stderr.trim()}`);
      }
      const dropped = (needle: string) =>
        res.stdout
          .split('\n')
          .some(
            (line) => line.includes(`-d ${needle}`) && line.includes('-j DROP'),
          );
      const missing = [
        !dropped(METADATA_RANGE) && METADATA_RANGE,
        !dropped(METADATA_IP) && !dropped(`${METADATA_IP}/32`) && METADATA_IP,
      ].filter(Boolean);
      return missing.length === 0
        ? pass(`DROP rules for ${METADATA_RANGE} and ${METADATA_IP}`)
        : fail(
            `no DROP rule for ${missing.join(' or ')} — a sandbox can steal cloud credentials from the metadata service`,
            `iptables -I DOCKER-USER -d ${METADATA_RANGE} -j DROP && iptables -I DOCKER-USER -d ${METADATA_IP} -j DROP`,
          );
    },
  },
  {
    id: 'metadata-persisted',
    title: 'firewall rules persisted',
    needs: ['metadata-firewall'],
    run: async (ctx) => {
      const rules = await ctx.readTextFile(RULES_V4);
      return rules?.includes(METADATA_IP) && rules.includes('169.254')
        ? pass(`both rules in ${RULES_V4}`)
        : warn(
            'the DROP rules live only in memory — a reboot silently drops them',
            'apt-get install -y iptables-persistent && netfilter-persistent save',
          );
    },
  },
  {
    id: 'api-token',
    title: 'DORMICE_API_TOKEN',
    run: async (ctx) => {
      const token = ctx.env.DORMICE_API_TOKEN;
      if (token === undefined || token === '') {
        return warn(
          'not set in this shell — the daemon refuses to start without it',
          'export DORMICE_API_TOKEN=$(openssl rand -hex 32)',
        );
      }
      return token.length >= 32
        ? pass(`set (${token.length} characters)`)
        : fail(
            `set but only ${token.length} characters — the daemon requires at least 32`,
            'export DORMICE_API_TOKEN=$(openssl rand -hex 32)',
          );
    },
  },
  {
    id: 's3-config',
    title: 'S3 archive configuration',
    run: async (ctx) => {
      const wanted = [
        'DORMICE_S3_ENDPOINT',
        'DORMICE_S3_BUCKET',
        'DORMICE_S3_ACCESS_KEY_ID',
        'DORMICE_S3_SECRET_ACCESS_KEY',
      ];
      const missing = wanted.filter((name) => !ctx.env[name]);
      if (missing.length === wanted.length) {
        return skip(
          'DORMICE_S3_* not set — the archiver is disabled; sandboxes park at stopped forever',
        );
      }
      if (missing.length > 0) {
        // The daemon's config schema refuses this too; naming it here saves
        // one failed boot.
        return fail(
          `partial S3 set: ${missing.join(', ')} missing — the daemon refuses a half-configured archiver`,
          'set all four DORMICE_S3_* variables (endpoint, bucket, key id, secret) or none',
        );
      }
      return pass('all four DORMICE_S3_* variables set — archiver enabled');
    },
  },
  {
    id: 'zstd',
    title: 'zstd available',
    needs: ['s3-config'],
    run: async (ctx) => {
      // Only the docker executor shells out to tar/zstd; the archiver runs
      // `tar -I zstd` on the host at every archive and restore.
      if (ctx.env.DORMICE_EXECUTOR !== 'docker') {
        return skip('only the docker executor archives with host tar+zstd');
      }
      const res = await ctx.run('zstd', ['--version']);
      return res.ok
        ? pass(res.stdout.trim().split('\n')[0] ?? 'present')
        : fail(
            'zstd is not installed — every archive attempt will fail at tar',
            'apt-get install -y zstd',
          );
    },
  },
  {
    id: 'base-image',
    title: 'base image available',
    needs: ['docker-daemon'],
    run: async (ctx) => {
      const image = baseImage(ctx);
      if (!image) {
        return skip(
          'DORMICE_BASE_IMAGE is not set — set it to check the image and enable the container probes',
        );
      }
      const res = await ctx.run('docker', ['image', 'inspect', image]);
      return res.ok
        ? pass(`${image} is present locally`)
        : fail(
            `${image} is not present locally`,
            'build it from images/Dockerfile — doctor never pulls images itself',
          );
    },
  },
  {
    id: 'absolute-paths',
    title: 'docker-mode paths absolute',
    run: async (ctx) => {
      if (ctx.env.DORMICE_EXECUTOR !== 'docker') {
        return skip('DORMICE_EXECUTOR is not "docker"');
      }
      // Same resolution the daemon does: unset falls back to the default,
      // and the default DB path is relative — which docker mode refuses.
      const paths = {
        DORMICE_DB_PATH: ctx.env.DORMICE_DB_PATH ?? 'data/dormice.db',
        DORMICE_DATA_DIR: ctx.env.DORMICE_DATA_DIR ?? '/var/lib/dormice',
      };
      const relative = Object.entries(paths)
        .filter(([, value]) => !isAbsolute(value))
        .map(([name, value]) => `${name}=${value}`);
      return relative.length === 0
        ? pass('DORMICE_DB_PATH and DORMICE_DATA_DIR are absolute')
        : fail(
            `${relative.join(', ')} — a relative path depends on the start directory, and a wrong start directory opens an empty ledger next to real sandboxes`,
            'export DORMICE_DB_PATH=/var/lib/dormice/dormice.db (or another absolute path)',
          );
    },
  },
  {
    id: 'disk-space',
    title: 'free disk space',
    needs: ['os-linux'],
    run: async (ctx) => {
      const dir = ctx.env.DORMICE_DATA_DIR ?? '/var/lib/dormice';
      let res = await ctx.run('df', ['-Pk', dir]);
      let note = '';
      if (!res.ok) {
        // The data dir may not exist before the first daemon start; the
        // root filesystem is the honest stand-in.
        res = await ctx.run('df', ['-Pk', '/']);
        note = ` (${dir} does not exist yet; measured /)`;
      }
      const kb = Number(res.stdout.trim().split('\n').at(-1)?.split(/\s+/)[3]);
      if (!res.ok || Number.isNaN(kb)) {
        return warn(`cannot measure free space: ${res.stderr.trim()}`);
      }
      const gib = kb / 1024 / 1024;
      return gib >= 10
        ? pass(`${gib.toFixed(1)} GiB free for ${dir}${note}`)
        : warn(
            `only ${gib.toFixed(1)} GiB free for ${dir}${note} — a full disk means even the ledger cannot write`,
          );
    },
  },
  {
    id: 'probe-gvisor',
    title: 'probe: gVisor fake kernel',
    needs: ['gvisor-runtime', 'base-image'],
    probe: true,
    run: async (ctx) => {
      const image = baseImage(ctx) as string;
      const res = await ctx.run(
        'docker',
        ['run', '--rm', '--runtime=runsc', image, 'uname', '-r'],
        { timeoutMs: 60_000 },
      );
      if (!res.ok)
        return fail(`the probe container failed: ${res.stderr.trim()}`);
      const kernel = res.stdout.trim();
      return kernel.includes('gvisor')
        ? pass(`sandbox kernel: ${kernel}`)
        : fail(
            `sandbox reports kernel "${kernel}" — that is a real kernel, gVisor is not isolating`,
            'reinstall gVisor (`runsc install`) and restart docker',
          );
    },
  },
  {
    id: 'probe-metadata',
    title: 'probe: metadata blocked inside',
    needs: ['gvisor-runtime', 'base-image'],
    probe: true,
    run: async (ctx) => {
      const res = await ctx.run(
        'docker',
        [
          'run',
          '--rm',
          '--runtime=runsc',
          baseImage(ctx) as string,
          'bash',
          '-c',
          `timeout 3 bash -c "</dev/tcp/${METADATA_IP}/80" && echo LEAK || echo BLOCKED`,
        ],
        { timeoutMs: 60_000 },
      );
      if (res.stdout.includes('BLOCKED')) {
        return pass('metadata service unreachable from inside a sandbox');
      }
      if (res.stdout.includes('LEAK')) {
        return fail(
          `a sandbox reached ${METADATA_IP} — cloud credentials are stealable`,
          `iptables -I DOCKER-USER -d ${METADATA_RANGE} -j DROP && iptables -I DOCKER-USER -d ${METADATA_IP} -j DROP`,
        );
      }
      return fail(`the probe container failed: ${res.stderr.trim()}`);
    },
  },
  {
    id: 'probe-image-user',
    title: 'probe: image runs as uid 1000',
    needs: ['gvisor-runtime', 'base-image'],
    probe: true,
    run: async (ctx) => {
      const res = await ctx.run(
        'docker',
        [
          'run',
          '--rm',
          '--runtime=runsc',
          baseImage(ctx) as string,
          'id',
          '-u',
        ],
        { timeoutMs: 60_000 },
      );
      if (!res.ok)
        return fail(`the probe container failed: ${res.stderr.trim()}`);
      const uid = res.stdout.trim();
      return uid === '1000'
        ? pass('uid 1000 (non-root)')
        : fail(
            `the image runs as uid ${uid} — sandboxes must run as a non-root uid-1000 user`,
            'rebuild the image with a uid-1000 user (see images/Dockerfile)',
          );
    },
  },
  {
    id: 'probe-image-inotify',
    title: 'probe: image has inotify-tools',
    needs: ['gvisor-runtime', 'base-image'],
    probe: true,
    run: async (ctx) => {
      const res = await ctx.run(
        'docker',
        [
          'run',
          '--rm',
          '--runtime=runsc',
          baseImage(ctx) as string,
          'bash',
          '-c',
          'command -v inotifywait || echo MISSING',
        ],
        { timeoutMs: 60_000 },
      );
      if (!res.ok)
        return fail(`the probe container failed: ${res.stderr.trim()}`);
      // A warn, not a fail: everything except E2B watch works without it,
      // and images built before 2026-07-10 honestly refuse watch at runtime.
      return res.stdout.includes('MISSING')
        ? warn(
            'inotifywait is missing — E2B directory watching will refuse to start',
            'rebuild the sandbox image from images/Dockerfile (it installs inotify-tools) and point DORMICE_BASE_IMAGE at the new tag',
          )
        : pass('inotifywait present — directory watching works');
    },
  },
];

const ICONS: Record<CheckStatus, string> = {
  pass: '✔',
  fail: '✖',
  warn: '⚠',
  skip: '·',
};

export interface DoctorReport {
  results: Record<string, CheckResult>;
  report: string;
  failed: boolean;
}

export async function runDoctor(
  ctx: DoctorContext,
  opts: { quick?: boolean } = {},
): Promise<DoctorReport> {
  const results: Record<string, CheckResult> = {};
  const titles: Record<string, string> = {};
  for (const check of CHECKS) titles[check.id] = check.title;

  for (const check of CHECKS) {
    if (opts.quick && check.probe) {
      results[check.id] = skip('container probes skipped (--quick)');
      continue;
    }
    const blocker = check.needs?.find((id) => results[id]?.status !== 'pass');
    if (blocker !== undefined) {
      results[check.id] = skip(`needs "${titles[blocker]}" to pass first`);
      continue;
    }
    results[check.id] = await check.run(ctx);
  }

  const width = Math.max(...CHECKS.map((check) => check.title.length));
  const lines = [
    'Dormice doctor — can this host run the daemon? (read-only, fixes are named, never applied)',
    '',
  ];
  for (const check of CHECKS) {
    const result = results[check.id] as CheckResult;
    lines.push(
      `${ICONS[result.status]} ${check.title.padEnd(width)}  ${result.detail}`,
    );
    if (result.fix && result.status !== 'pass') {
      lines.push(`  ${' '.repeat(width)}  fix: ${result.fix}`);
    }
  }

  const count = (status: CheckStatus) =>
    Object.values(results).filter((result) => result.status === status).length;
  const failed = count('fail') > 0;
  lines.push(
    '',
    `${count('pass')} passed, ${count('fail')} failed, ${count('warn')} warnings, ${count('skip')} skipped.`,
  );
  lines.push(
    failed
      ? 'Not ready — fix the ✖ items above and run doctor again.'
      : count('warn') > 0
        ? 'No failures — review the ⚠ items above.'
        : 'This host looks ready to run the Dormice daemon.',
  );

  return { results, report: lines.join('\n'), failed };
}
