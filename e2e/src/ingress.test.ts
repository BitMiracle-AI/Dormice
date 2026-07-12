import { readFileSync, writeFileSync } from 'node:fs';
import { Dormice } from '@dormice/sdk';
import { describe, expect, inject, it } from 'vitest';

// Web domain binding, black-box: the daemon owns a Caddy config file (the
// exam points DORMICE_INGRESS_FILE into its temp dir, reload is a no-op —
// Caddy's half is real-machine acceptance). The file is an operator-visible
// artifact, so reading and tampering with it from the test is fair play:
// that is exactly what an operator can do.
//
// Tests in this file share the daemon's single ingress state, so they run
// as one ordered story instead of independent keys.

function client() {
  return new Dormice({
    endpoint: inject('dormiceEndpoint'),
    token: inject('dormiceToken'),
  });
}

describe('ingress domain binding over a real daemon', () => {
  it('walks bind → add → status → drop → clear, with the file telling the same story', async () => {
    const file = inject('dormiceIngressFile');

    // Managed but unbound: the daemon has a file knob, nothing written yet.
    const before = await client().getIngress();
    expect(before).toEqual({ managed: true, domains: [] });

    // Bind. The exam domain has no DNS record — binding must still be
    // accepted (write the intent, let the probes report reality honestly).
    const bound = await client().setIngress(['console.dormice-e2e.test']);
    expect(bound).toEqual({ domains: ['console.dormice-e2e.test'] });

    // Add a second: send the full set (set semantics, not a patch).
    await client().setIngress([
      'console.dormice-e2e.test',
      'api.dormice-e2e.test',
    ]);
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('# Managed by Dormice');
    expect(content).toContain('console.dormice-e2e.test {');
    expect(content).toContain('api.dormice-e2e.test {');
    expect(content).toContain(':80 {'); // the no-lockout catch-all

    // Status carries live probes per domain; on record-less domains they
    // are honest reds/empties, never invented greens.
    const status = await client().getIngress();
    expect(status.managed).toBe(true);
    expect(status.domains.map((d) => d.domain)).toEqual([
      'console.dormice-e2e.test',
      'api.dormice-e2e.test',
    ]);
    for (const { probe } of status.domains) {
      expect(probe.tlsOk).toBe(false);
    }

    // Drop one: the remaining set survives, the dropped site is gone.
    await client().setIngress(['api.dormice-e2e.test']);
    expect(readFileSync(file, 'utf8')).not.toContain(
      'console.dormice-e2e.test',
    );

    // Clear falls back to IP-only.
    const cleared = await client().setIngress([]);
    expect(cleared).toEqual({ domains: [] });
    expect((await client().getIngress()).domains).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toContain('dormice-e2e.test');
  });

  it('rejects a domain with a scheme, names the shape it wants', async () => {
    await expect(
      client().setIngress(['https://console.example.com']),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('bare hostname'),
    });
  });

  it('refuses to overwrite a config file it does not own, and recovers', async () => {
    const file = inject('dormiceIngressFile');
    const ours = readFileSync(file, 'utf8');
    writeFileSync(file, ':80 {\n\trespond "hand-edited"\n}\n');
    await expect(
      client().setIngress(['console.dormice-e2e.test']),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('not written by Dormice'),
    });
    // The operator's hand-edited file is untouched by the refusal.
    expect(readFileSync(file, 'utf8')).toContain('hand-edited');
    writeFileSync(file, ours);
    expect((await client().getIngress()).domains).toEqual([]);
  });

  it('records binds in the activity window', async () => {
    await client().setIngress(['activity.dormice-e2e.test']);
    await client().setIngress([]);
    const events = await client().listActivity();
    const details = events
      .filter((event) => event.kind === 'ingress-updated')
      .map((event) => event.detail);
    expect(details.length).toBeGreaterThanOrEqual(2);
    expect(details.some((d) => d.includes('activity.dormice-e2e.test'))).toBe(
      true,
    );
  });
});
