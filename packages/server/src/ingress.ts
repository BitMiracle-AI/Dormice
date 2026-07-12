import { Resolver } from 'node:dns/promises';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import tls from 'node:tls';
import type { GetIngressResponse, IngressProbe } from '@dormice/shared';
import { execa } from 'execa';

/**
 * The daemon's own front door: a Caddy config file it owns, rewritten on
 * setIngress and reloaded into the running Caddy. The file is the single
 * source of truth — no ledger column, no boot-time reconcile: an operator
 * can read it, Caddy runs it, and getIngress parses it back. TLS is
 * entirely Caddy's job (ACME issuance and renewal); this class only decides
 * what the file says.
 *
 * The generated shape is two site blocks: the bound domain (Caddy obtains a
 * certificate and auto-redirects http://<domain> to https) and a plain :80
 * catch-all proxying by IP. The catch-all is the no-lockout guarantee — a
 * bind that never converges (typo'd domain, missing DNS record) leaves IP
 * access untouched. Caddy inserts its automatic HTTPS redirects after
 * host-matched routes but before user catch-alls, so the two coexist.
 */

/**
 * Ownership marker, line one of every file this class writes. A file the
 * knob points at that lacks it was written by someone else — refused, never
 * overwritten. install.sh writes the same marker (kept in sync by hand).
 */
const MARKER = '# Managed by Dormice — setIngress rewrites this file.';

/** The knob points at a file this daemon does not own. */
export class UnmanagedIngressFileError extends Error {}

export interface IngressOptions {
  /** The Caddy config file the daemon owns (DORMICE_INGRESS_FILE). */
  filePath: string;
  /** Where the proxy forwards to: the daemon's own loopback port. */
  upstreamPort: number;
  /**
   * Shell command that makes the running proxy read the new config.
   * Defaults to `caddy reload` against the standard Caddyfile — right when
   * the daemon owns the whole file; an operator whose own Caddyfile imports
   * a fragment overrides this to reload the outer file instead.
   */
  reloadCommand?: string;
  /** Test seam; production shells out through execa. */
  runCommand?: (command: string) => Promise<{ ok: boolean; stderr: string }>;
  /** Test seams for the two probes; production asks DNS and 127.0.0.1:443. */
  resolveDomain?: (
    domain: string,
  ) => Promise<Pick<IngressProbe, 'dnsAddresses' | 'dnsError'>>;
  probeTls?: (
    domain: string,
  ) => Promise<Pick<IngressProbe, 'tlsOk' | 'tlsError'>>;
}

export class Ingress {
  private readonly filePath: string;
  private readonly upstreamPort: number;
  private readonly reloadCommand: string;
  private readonly runCommand: NonNullable<IngressOptions['runCommand']>;
  private readonly resolveDomain: NonNullable<IngressOptions['resolveDomain']>;
  private readonly probeTls: NonNullable<IngressOptions['probeTls']>;
  /** Serializes writes: two concurrent binds must not interleave write+reload. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: IngressOptions) {
    this.filePath = options.filePath;
    this.upstreamPort = options.upstreamPort;
    this.reloadCommand =
      options.reloadCommand ??
      `caddy reload --config ${options.filePath} --adapter caddyfile`;
    this.runCommand = options.runCommand ?? runShellCommand;
    this.resolveDomain = options.resolveDomain ?? resolveDomainDns;
    this.probeTls = options.probeTls ?? probeLocalTls;
  }

  /**
   * The currently bound domain, read back from the file. Null when nothing
   * is bound, the file does not exist yet, or the file is not ours — a
   * foreign file's site addresses are not this daemon's to report.
   */
  domain(): string | null {
    if (!existsSync(this.filePath)) return null;
    const content = readFileSync(this.filePath, 'utf8');
    if (!content.includes('Managed by Dormice')) return null;
    for (const line of content.split('\n')) {
      // Site addresses sit at column 0 in the generated shape; indented
      // lines are directives (`\treverse_proxy … {`), never sites.
      const site = /^([^\s#:{][^\s{]*)\s*\{/.exec(line);
      if (site?.[1]) return site[1];
    }
    return null;
  }

  /**
   * Rewrites the file for the given domain (null = back to IP-only) and
   * reloads the proxy. On a failed reload the previous file is restored —
   * `caddy reload` rejects a bad config without applying it, so file and
   * running proxy stay consistent — and the failure is thrown with Caddy's
   * own words.
   */
  setDomain(domain: string | null): Promise<void> {
    const run = this.queue.then(() => this.apply(domain));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Everything getIngress reports: the file's word plus live probes. */
  async status(): Promise<GetIngressResponse> {
    const domain = this.domain();
    if (domain === null) return { managed: true, domain: null, probe: null };
    const [dns, cert] = await Promise.all([
      this.resolveDomain(domain),
      this.probeTls(domain),
    ]);
    return { managed: true, domain, probe: { ...dns, ...cert } };
  }

  private async apply(domain: string | null): Promise<void> {
    const previous = existsSync(this.filePath)
      ? readFileSync(this.filePath, 'utf8')
      : null;
    if (
      previous !== null &&
      previous.trim() !== '' &&
      !previous.includes('Managed by Dormice')
    ) {
      throw new UnmanagedIngressFileError(
        `${this.filePath} was not written by Dormice — refusing to overwrite it; ` +
          'move your configuration elsewhere, or point DORMICE_INGRESS_FILE at a file the daemon may own',
      );
    }
    writeFileSync(this.filePath, this.render(domain));
    const reload = await this.runCommand(this.reloadCommand);
    if (!reload.ok) {
      if (previous === null) unlinkSync(this.filePath);
      else writeFileSync(this.filePath, previous);
      throw new Error(
        `reloading the proxy failed (${this.reloadCommand}): ${reload.stderr.trim()} — the previous configuration was restored`,
      );
    }
  }

  private render(domain: string | null): string {
    // flush_interval -1 streams byte-by-byte: buffering would dam the
    // console terminal and E2B's streaming exec (measured through Caddy).
    const site = (address: string) =>
      `${address} {\n\treverse_proxy 127.0.0.1:${this.upstreamPort} {\n\t\tflush_interval -1\n\t}\n}\n`;
    return [
      `${MARKER}\n`,
      ...(domain === null ? [] : [site(domain)]),
      site(':80'),
    ].join('\n');
  }
}

async function runShellCommand(
  command: string,
): Promise<{ ok: boolean; stderr: string }> {
  try {
    await execa(command, { shell: true, timeout: 30_000 });
    return { ok: true, stderr: '' };
  } catch (error) {
    const stderr =
      error instanceof Error
        ? ('stderr' in error && String(error.stderr)) || error.message
        : String(error);
    return { ok: false, stderr };
  }
}

/**
 * What the domain resolves to right now. "No record" (the state before the
 * operator's A record lands or propagates) is an empty list, not an error;
 * dnsError is reserved for the resolver itself failing.
 */
async function resolveDomainDns(
  domain: string,
): Promise<Pick<IngressProbe, 'dnsAddresses' | 'dnsError'>> {
  const resolver = new Resolver({ timeout: 3_000, tries: 1 });
  const lookup = async (kind: 'resolve4' | 'resolve6') => {
    try {
      return await resolver[kind](domain);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
      throw error;
    }
  };
  try {
    const [v4, v6] = await Promise.all([
      lookup('resolve4'),
      lookup('resolve6'),
    ]);
    return { dnsAddresses: [...v4, ...v6], dnsError: null };
  } catch (error) {
    return {
      dnsAddresses: [],
      dnsError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Does the local proxy serve a valid trusted certificate for the domain?
 * A handshake against 127.0.0.1:443 with the domain as SNI — deliberately
 * not a fetch of the public URL: cloud NAT usually cannot hairpin a host's
 * own public IP, so the honest local fact is "certificate issued and
 * served", and public reachability stays the security group's question.
 */
function probeLocalTls(
  domain: string,
): Promise<Pick<IngressProbe, 'tlsOk' | 'tlsError'>> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: 443,
      servername: domain,
      rejectUnauthorized: true,
    });
    const done = (result: Pick<IngressProbe, 'tlsOk' | 'tlsError'>) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(3_000, () =>
      done({ tlsOk: false, tlsError: 'timed out connecting to 127.0.0.1:443' }),
    );
    socket.once('secureConnect', () => done({ tlsOk: true, tlsError: null }));
    socket.once('error', (error) =>
      done({ tlsOk: false, tlsError: error.message }),
    );
  });
}
