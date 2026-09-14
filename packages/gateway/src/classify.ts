import { parseSandboxHost } from '@dormice/shared';

/**
 * Which face a raw request belongs to — the gateway's serverFactory
 * triages every request before Fastify's router sees it, because three
 * faces are keyed on something Fastify cannot route on (a header, on any
 * path). Pure, so the order of the tests is a fact here and nowhere else:
 *   proxy       Host `<port>-<sandboxId>.<domain>`, for a domain in the
 *               group in force (the gateway's own settings: the sandbox
 *               domain and its inbound aliases, handed in per request) —
 *               E2B's getHost() URL, the sandbox port proxy. Judged first,
 *               as on the daemon, where the proxy stands in front of the
 *               router: whatever path a sandbox host spells is the
 *               sandbox's, never a verb of the door.
 *   envd        /e2b/envd/* — E2B's in-sandbox API, keyed by the
 *               E2b-Sandbox-Id header.
 *   signedRoot  exactly /files at the root — the bare signed-URL form,
 *               which carries no sandbox id anywhere the gateway can read
 *               without the node's signing secret.
 *   fastify     everything else — the native verbs, /e2b/api, /healthz,
 *               the gateway's own verbs.
 */
export type Classified =
  | { face: 'proxy'; port: number; sandboxId: string }
  | { face: 'envd' }
  | { face: 'signedRoot' }
  | { face: 'fastify' };

/**
 * Only the origin-form request target (RFC 9112 §3.2.1, a path starting
 * with `/`) is forwarded. The gateway routes on the path Fastify extracts
 * — find-my-way strips a scheme and authority off an absolute-form target
 * — and sends the target to the node byte for byte, so on an absolute
 * form the two would read different requests: `POST http://8000-<id>.
 * <domain>/execCommand` is `/execCommand` to the gateway (a native verb,
 * authenticated, the fleet's token attached) and, to the RFC-7230 hop in
 * front of the node (Caddy: Host := the target's authority), a request to
 * the node's sandbox proxy — the fleet's credential delivered into the
 * tenant's own sandbox (traced 2026-09-12). Absolute form is what a
 * client sends a forward proxy, which the gateway is not; every real
 * client of an origin server sends origin form, so refusing the rest
 * costs nothing and keeps the invariant whole: the gateway and the node
 * see the same request.
 */
export function isOriginForm(req: { url?: string }): boolean {
  return (req.url ?? '').startsWith('/');
}

export function classify(
  req: { url?: string; headers: { host?: string } },
  domains: readonly string[],
): Classified {
  const sandbox = parseSandboxHost(req.headers.host, domains);
  if (sandbox) return { face: 'proxy', ...sandbox };
  const url = req.url ?? '';
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  if (url.startsWith('/e2b/envd/')) return { face: 'envd' };
  if (path === '/files') return { face: 'signedRoot' };
  return { face: 'fastify' };
}
