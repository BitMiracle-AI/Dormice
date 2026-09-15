import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getIngressResponseSchema } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { Ingress } from './ingress';
import { TEST_TOKEN, testGateway } from './testing';

// The managed front door: the config file is the single source of truth,
// so most of what matters is what ends up in the file — and that a failed
// reload never leaves file and running proxy telling different stories.

const authed = { authorization: `Bearer ${TEST_TOKEN}` };

function tmpFile(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), 'dormice-ingress-')),
    'Caddyfile',
  );
}

function testIngress(
  overrides: Partial<ConstructorParameters<typeof Ingress>[0]> = {},
) {
  const filePath = overrides.filePath ?? tmpFile();
  const reloads: string[] = [];
  const ingress = new Ingress({
    filePath,
    upstreamPort: 3677,
    runCommand: async (command) => {
      reloads.push(command);
      return { ok: true, stderr: '' };
    },
    resolveDomain: async () => ({ dnsAddresses: ['1.2.3.4'], dnsError: null }),
    probeTls: async () => ({ tlsOk: true, tlsError: null }),
    ...overrides,
  });
  return { ingress, filePath, reloads };
}

describe('Ingress file round-trip', () => {
  it('binds domains: marker, one site each, :80 catch-all pointing at the gateway — and reads them back in order', async () => {
    const { ingress, filePath, reloads } = testIngress();
    await ingress.setDomains(['console.example.com', 'api.example.com']);
    const content = readFileSync(filePath, 'utf8');
    expect(content.startsWith('# Managed by Dormice')).toBe(true);
    expect(content).toContain('console.example.com {');
    expect(content).toContain('api.example.com {');
    // The no-lockout guarantee: IP access survives every bind.
    expect(content).toContain(':80 {');
    expect(content).toContain('reverse_proxy 127.0.0.1:3677');
    expect(content).toContain('flush_interval -1');
    expect(ingress.domains()).toEqual([
      'console.example.com',
      'api.example.com',
    ]);
    expect(reloads).toHaveLength(1);
  });

  it('lowercases and dedups: hostnames are case-insensitive, the file decides once', async () => {
    const { ingress } = testIngress();
    await ingress.setDomains([
      'Console.Example.COM',
      'console.example.com',
      'api.example.com',
    ]);
    expect(ingress.domains()).toEqual([
      'console.example.com',
      'api.example.com',
    ]);
  });

  it('clears back to IP-only, and reports empty before any file exists', async () => {
    const { ingress, filePath } = testIngress();
    expect(ingress.domains()).toEqual([]);
    await ingress.setDomains(['console.example.com']);
    await ingress.setDomains([]);
    const content = readFileSync(filePath, 'utf8');
    expect(content).not.toContain('example.com');
    expect(content).toContain(':80 {');
    expect(ingress.domains()).toEqual([]);
  });

  it('defaults the reload command to caddy reload against its own file', async () => {
    const filePath = tmpFile();
    const reloads: string[] = [];
    const ingress = new Ingress({
      filePath,
      upstreamPort: 3677,
      runCommand: async (command) => {
        reloads.push(command);
        return { ok: true, stderr: '' };
      },
    });
    await ingress.setDomains([]);
    expect(reloads).toEqual([
      `caddy reload --config ${filePath} --adapter caddyfile`,
    ]);
  });

  it('serializes concurrent binds: the last write wins, reloads never interleave', async () => {
    const filePath = tmpFile();
    const order: string[] = [];
    const ingress = new Ingress({
      filePath,
      upstreamPort: 3677,
      runCommand: async () => {
        order.push(
          `reload:${readFileSync(filePath, 'utf8').includes('a.example.com') ? 'a' : 'b'}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true, stderr: '' };
      },
    });
    await Promise.all([
      ingress.setDomains(['a.example.com']),
      ingress.setDomains(['b.example.com']),
    ]);
    expect(order).toEqual(['reload:a', 'reload:b']);
    expect(ingress.domains()).toEqual(['b.example.com']);
  });
});

describe('Ingress refusals and rollback', () => {
  it('refuses to overwrite a file it did not write', async () => {
    const filePath = tmpFile();
    writeFileSync(filePath, 'example.org {\n\trespond "mine"\n}\n');
    const { ingress } = testIngress({ filePath });
    await expect(ingress.setDomains(['console.example.com'])).rejects.toThrow(
      /not written by Dormice/,
    );
    expect(readFileSync(filePath, 'utf8')).toContain('respond "mine"');
    expect(ingress.domains()).toEqual([]);
  });

  it('restores the previous file when the reload fails', async () => {
    const { ingress, filePath } = testIngress();
    await ingress.setDomains(['good.example.com']);
    const { ingress: failing } = testIngress({
      filePath,
      runCommand: async () => ({ ok: false, stderr: 'adapting config: no' }),
    });
    await expect(failing.setDomains(['bad.example.com'])).rejects.toThrow(
      /adapting config: no/,
    );
    expect(readFileSync(filePath, 'utf8')).toContain('good.example.com');
  });

  it('removes the file it just created when the first-ever reload fails', async () => {
    const { ingress, filePath } = testIngress({
      runCommand: async () => ({ ok: false, stderr: 'caddy not running' }),
    });
    await expect(ingress.setDomains(['x.example.com'])).rejects.toThrow(
      /caddy not running/,
    );
    expect(existsSync(filePath)).toBe(false);
  });
});

describe('ingress routes on the gateway', () => {
  type App = ReturnType<typeof testGateway>['app'];
  const rpc = (
    app: App,
    url: string,
    payload: Record<string, unknown> = {},
    headers: Record<string, string> = authed,
  ) => app.inject({ method: 'POST', url, headers, payload });

  it('without a managed ingress: getIngress is honest, setIngress refuses naming the gateway env', async () => {
    const { app } = testGateway();
    const get = await rpc(app, '/getIngress');
    expect(get.statusCode).toBe(200);
    expect(getIngressResponseSchema.parse(get.json())).toEqual({
      managed: false,
      domains: [],
    });
    const set = await rpc(app, '/setIngress', {
      domains: ['a.example.com'],
    });
    expect(set.statusCode).toBe(400);
    expect(set.json().message).toContain('DORMICE_INGRESS_FILE');
    expect(set.json().message).toContain('gateway');
  });

  it('binds two, probes each, drops one, clears', async () => {
    const { ingress } = testIngress();
    const { app } = testGateway({}, { ingress });

    const set = await rpc(app, '/setIngress', {
      domains: ['console.example.com', 'api.example.com'],
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({
      domains: ['console.example.com', 'api.example.com'],
    });

    const get = await rpc(app, '/getIngress');
    const status = getIngressResponseSchema.parse(get.json());
    const probe = {
      dnsAddresses: ['1.2.3.4'],
      dnsError: null,
      tlsOk: true,
      tlsError: null,
    };
    expect(status).toEqual({
      managed: true,
      domains: [
        { domain: 'console.example.com', probe },
        { domain: 'api.example.com', probe },
      ],
    });

    const dropped = await rpc(app, '/setIngress', {
      domains: ['api.example.com'],
    });
    expect(dropped.json()).toEqual({ domains: ['api.example.com'] });

    const cleared = await rpc(app, '/setIngress', { domains: [] });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ domains: [] });
  });

  it('rejects a domain with a scheme at the schema gate', async () => {
    const { ingress } = testIngress();
    const { app } = testGateway({}, { ingress });
    const res = await rpc(app, '/setIngress', {
      domains: ['https://console.example.com'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('bare hostname');
  });

  it('maps a foreign file to 409 and a failed reload to 500, with the reason', async () => {
    const filePath = tmpFile();
    writeFileSync(filePath, 'someone-elses-site {\n}\n');
    const foreign = testGateway(
      {},
      { ingress: testIngress({ filePath }).ingress },
    );
    const refused = await rpc(foreign.app, '/setIngress', {
      domains: ['a.example.com'],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain('not written by Dormice');

    const broken = testGateway(
      {},
      {
        ingress: testIngress({
          runCommand: async () => ({ ok: false, stderr: 'connection refused' }),
        }).ingress,
      },
    );
    const failed = await rpc(broken.app, '/setIngress', {
      domains: ['a.example.com'],
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json().message).toContain('connection refused');
  });

  it('is admin-only (design record #9): a minted key can neither read nor rewrite the front door', async () => {
    const { ingress } = testIngress();
    const { app } = testGateway({}, { ingress });
    const minted = await rpc(app, '/createApiKey', { name: 'robot' });
    const asKey = { authorization: `Bearer ${minted.json().token}` };
    const set = await rpc(
      app,
      '/setIngress',
      { domains: ['evil.example.com'] },
      asKey,
    );
    expect(set.statusCode).toBe(403);
    expect(set.json().message).toMatch(/cannot manage API keys/);
    expect((await rpc(app, '/getIngress', {}, asKey)).statusCode).toBe(403);
    expect(ingress.domains()).toEqual([]);
  });
});
