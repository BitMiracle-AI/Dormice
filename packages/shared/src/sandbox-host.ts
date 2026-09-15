import type { RuntimeSettings } from './settings';

/**
 * E2B's URL grammar for a sandbox's port, shared by the two doors that key
 * on it: the Host header `<port>-<sandboxId>.<domain>` — what the SDK's
 * getHost() builds from the `domain` field a create answers with. The
 * daemon's sandbox port proxy (server/sandbox-proxy.ts) reads it to dial
 * the container; the gateway's proxy face (gateway/classify.ts, raw.ts)
 * reads it to find the node holding the sandbox and forward the request
 * there whole, Host kept. One parser, so a host names the same sandbox at
 * both doors.
 */

/**
 * envd's fixed port in E2B's URL grammar: `49983-<sandboxId>.<domain>`
 * reaches the sandbox's envd, never a user process — it is how the SDK's
 * uploadUrl/downloadUrl become browser-postable URLs. Dormice runs no envd
 * inside the container (the daemon plays that role), so /files on this
 * port is carved out of the daemon's proxy and lands on its signed-URL
 * file door, with the Host label pinning which sandbox the signature must
 * speak for (server/e2b/signed-files.ts). Every other path keeps the
 * honest proxy answer: nothing listens on 49983 inside the sandbox. The
 * gateway forwards this form like any other sandbox host; the node does
 * the carving, the gateway answers its preflights and wears CORS on its
 * own refusals to it (isEnvdFilesForm below is the one judgment of it).
 */
export const ENVD_PORT = 49983;

/**
 * Exactly `/files`, query ignored — the path of both signed-URL forms,
 * the bare daemon root and the 49983 subdomain (isEnvdFilesForm).
 */
export function isFilesPath(url: string | undefined): boolean {
  const target = url ?? '';
  const q = target.indexOf('?');
  return (q === -1 ? target : target.slice(0, q)) === '/files';
}

/**
 * The browser-postable signed-URL form: envd's port in the Host label and
 * the /files path — `49983-<sandboxId>.<domain>/files`. Judged here for
 * both doors, so what is browser-direct at one is browser-direct at the
 * other: the daemon's proxy carves it out of port forwarding onto its
 * signed door (server/sandbox-proxy.ts), the gateway answers its
 * preflights itself and wears CORS on its own refusals to it
 * (gateway/raw.ts).
 */
export function isEnvdFilesForm(
  port: number,
  url: string | undefined,
): boolean {
  return port === ENVD_PORT && isFilesPath(url);
}

/**
 * The domain group inbound matching runs against: the canonical domain
 * first, then the inbound-only aliases; empty when the feature is off
 * (sandboxDomain null). The one adjudication of "off = never a match" —
 * both proxies' per-request getters and the signed-URL host pin call this
 * instead of deciding it themselves.
 */
export function sandboxDomainsInForce(
  settings: Pick<RuntimeSettings, 'sandboxDomain' | 'sandboxDomainAliases'>,
): string[] {
  return settings.sandboxDomain
    ? [settings.sandboxDomain, ...settings.sandboxDomainAliases]
    : [];
}

/**
 * Host header -> { port, sandboxId }, or null when it is not sandbox
 * traffic (then the request belongs to the router). The port suffix of the
 * header itself (`:3676`, `:3677`) is the door's port, not the sandbox's —
 * the label carries that.
 *
 * Every domain gets a full parse, never first-suffix-wins: an alias may be
 * a subdomain of another listed domain, and a host under it would suffix-
 * match the shorter domain first with a dotted label the regex refuses.
 */
export function parseSandboxHost(
  hostHeader: string | undefined,
  domains: readonly string[],
): { port: number; sandboxId: string } | null {
  if (!hostHeader) return null;
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  for (const domain of domains) {
    // Empty means "no domain in force" — never a match. Explicit, not left
    // to the suffix check: `.` + '' would make every dotted host a candidate.
    if (!domain) continue;
    const suffix = `.${domain.toLowerCase()}`;
    if (!host.endsWith(suffix)) continue;
    const label = host.slice(0, -suffix.length);
    const match = label.match(
      /^(\d{1,5})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    );
    if (!match) continue;
    const port = Number(match[1]);
    if (port < 1 || port > 65535) continue;
    return { port, sandboxId: match[2] as string };
  }
  return null;
}
