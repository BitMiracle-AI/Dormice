import type Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { DockerExecutor, namesRegistry, splitRepoTag } from './docker';

/**
 * ensureImage's branches against a stub Docker client — the contract exam
 * cannot reach them (it has no registry to pull from): an image the host
 * has is left alone; a bare image the host lacks comes from the fleet
 * registry under the fleet credential and is tagged back under its bare
 * name; an image naming its own registry is pulled as written, no
 * credential; no registry is a refusal that says both ways out; a pull
 * that fails names the push command; two callers share one pull. The
 * real pull is the test machine's (a tagged probe image through the
 * fleet registry, 手册).
 */

interface Stub {
  docker: Docker;
  calls: {
    inspected: string[];
    pulled: Array<{ source: string; auth: unknown }>;
    tagged: Array<{ source: string; repo: string; tag: string }>;
  };
  /** Which images "the host has" — inspect answers 200 for these, 404 otherwise. */
  present: Set<string>;
}

function stubDocker(opts: { failPull?: string } = {}): Stub {
  const present = new Set<string>();
  const calls: Stub['calls'] = { inspected: [], pulled: [], tagged: [] };
  let release: (() => void) | null = null;
  const docker = {
    getImage(name: string) {
      return {
        async inspect() {
          calls.inspected.push(name);
          if (!present.has(name)) {
            throw Object.assign(new Error('no such image'), {
              statusCode: 404,
            });
          }
          return { Id: 'sha256:abc' };
        },
        async tag(o: { repo: string; tag: string }) {
          calls.tagged.push({ source: name, ...o });
          present.add(`${o.repo}:${o.tag}`);
        },
      };
    },
    async pull(source: string, o: { authconfig?: unknown }) {
      calls.pulled.push({ source, auth: o.authconfig });
      return { source };
    },
    modem: {
      followProgress(
        stream: { source: string },
        done: (err: Error | null) => void,
      ) {
        if (opts.failPull === stream.source) {
          done(new Error('manifest unknown: manifest unknown'));
          return;
        }
        // Held until the test releases it, so two callers can be seen to
        // share the one pull; released at once when nobody holds it.
        const finish = () => {
          present.add(stream.source);
          done(null);
        };
        if (release === null) {
          release = finish;
          setTimeout(() => {
            if (release === finish) {
              release = null;
              finish();
            }
          }, 20);
        } else {
          finish();
        }
      },
    },
  };
  return { docker: docker as unknown as Docker, calls, present };
}

function executor(stub: Stub, registry: string | null): DockerExecutor {
  return new DockerExecutor(
    {
      baseImage: () => 'dormice-base:20260831',
      registry: {
        address: () => registry,
        username: 'dormice',
        password: 'fleet-token-fleet-token-fleet-token-fleet',
      },
      dataDir: '/nonexistent',
      resources: () => ({ diskSizeGb: 1, cpus: 1, memoryGb: 1 }),
      pidsLimit: () => 4096,
      reclaimTimeoutSeconds: 1,
    },
    stub.docker,
  );
}

describe('image references', () => {
  it('namesRegistry: a first component with a dot, a colon or "localhost" is a host; a bare name is not, whatever its tag', () => {
    expect(namesRegistry('dormice-base:20260831')).toBe(false);
    expect(namesRegistry('clawsgo_20260808_base:20260907')).toBe(false);
    expect(namesRegistry('library/python:3.12')).toBe(false);
    expect(namesRegistry('docker.io/library/python:3.12')).toBe(true);
    expect(namesRegistry('ghcr.io/x/y')).toBe(true);
    expect(namesRegistry('10.0.0.5:5000/dormice-base:20260831')).toBe(true);
    expect(namesRegistry('localhost/x')).toBe(true);
    expect(namesRegistry('registry:5000/x')).toBe(true);
  });

  it('splitRepoTag: repository and tag, latest when none; a digest is refused', () => {
    expect(splitRepoTag('dormice-base:20260831')).toEqual({
      repo: 'dormice-base',
      tag: '20260831',
    });
    expect(splitRepoTag('dormice-base')).toEqual({
      repo: 'dormice-base',
      tag: 'latest',
    });
    expect(splitRepoTag('team/app:v1')).toEqual({
      repo: 'team/app',
      tag: 'v1',
    });
    expect(() => splitRepoTag('x@sha256:abcd')).toThrow(/pinned by digest/);
  });
});

describe('DockerExecutor.ensureImage', () => {
  it('an image the host has is present, nothing pulled', async () => {
    const stub = stubDocker();
    stub.present.add('dormice-base:20260831');
    expect(
      await executor(stub, '10.0.0.5:5000').ensureImage(
        'dormice-base:20260831',
      ),
    ).toBe('present');
    expect(stub.calls.pulled).toEqual([]);
  });

  it('a bare image the host lacks is pulled from the fleet registry under the fleet credential and tagged back under its bare name', async () => {
    const stub = stubDocker();
    expect(await executor(stub, '10.0.0.5:5000').ensureImage('tpl:1')).toBe(
      'pulled',
    );
    expect(stub.calls.pulled).toEqual([
      {
        source: '10.0.0.5:5000/tpl:1',
        auth: {
          username: 'dormice',
          password: 'fleet-token-fleet-token-fleet-token-fleet',
          serveraddress: '10.0.0.5:5000',
        },
      },
    ]);
    expect(stub.calls.tagged).toEqual([
      { source: '10.0.0.5:5000/tpl:1', repo: 'tpl', tag: '1' },
    ]);
    expect(stub.present.has('tpl:1')).toBe(true);
  });

  it('an image naming its own registry is pulled as written, with no credential and no re-tag', async () => {
    const stub = stubDocker();
    expect(
      await executor(stub, '10.0.0.5:5000').ensureImage(
        'docker.io/library/python:3.12',
      ),
    ).toBe('pulled');
    expect(stub.calls.pulled).toEqual([
      { source: 'docker.io/library/python:3.12', auth: undefined },
    ]);
    expect(stub.calls.tagged).toEqual([]);
  });

  it('no registry and a bare image the host lacks is a refusal naming both ways out', async () => {
    const stub = stubDocker();
    await expect(executor(stub, null).ensureImage('tpl:1')).rejects.toThrow(
      /image tpl:1 is not on this host and the fleet has no registry — build or docker pull it under that name on this host, or run the fleet registry/,
    );
    expect(stub.calls.pulled).toEqual([]);
  });

  it("a pull the registry refuses names the image, the registry's word and the push command", async () => {
    const stub = stubDocker({ failPull: '10.0.0.5:5000/tpl:1' });
    await expect(
      executor(stub, '10.0.0.5:5000').ensureImage('tpl:1'),
    ).rejects.toThrow(
      /image tpl:1 is not on this host, and pulling 10\.0\.0\.5:5000\/tpl:1 from the fleet registry failed: manifest unknown.*docker tag tpl:1 10\.0\.0\.5:5000\/tpl:1 && docker push 10\.0\.0\.5:5000\/tpl:1/,
    );
    expect(stub.calls.tagged).toEqual([]);
  });

  it('two callers asking for the same missing image share one pull', async () => {
    const stub = stubDocker();
    const ex = executor(stub, '10.0.0.5:5000');
    const [a, b] = await Promise.all([
      ex.ensureImage('tpl:1'),
      ex.ensureImage('tpl:1'),
    ]);
    expect([a, b]).toEqual(['pulled', 'pulled']);
    expect(stub.calls.pulled).toHaveLength(1);
  });
});
