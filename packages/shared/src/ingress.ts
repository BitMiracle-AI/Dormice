import { z } from 'zod';

/**
 * getIngress()/setIngress() — the daemon's own front door. When the daemon
 * manages a Caddy config file (DORMICE_INGRESS_FILE), setIngress rewrites it
 * with one site block per bound domain and reloads Caddy; Caddy then obtains
 * and renews each TLS certificate on its own (ACME). The daemon itself keeps
 * binding 127.0.0.1 — what these verbs manage is the reverse proxy in front
 * of it.
 *
 * There is no stored state besides the config file: the file is the single
 * source of truth, and getIngress reads it back plus probes reality per
 * domain (DNS, the certificate actually served) so a browser can watch each
 * bind converge with honest progress instead of a spinner.
 */

/** Same shape rule as DORMICE_SANDBOX_DOMAIN: a bare hostname. */
export const ingressDomainSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, {
    error:
      'domain must be a bare hostname like console.example.com — no scheme, no port, no leading/trailing dots',
  });

export const setIngressRequestSchema = z.object({
  /**
   * The full set of domains to serve — set semantics, not a patch: the
   * proxy config is rewritten to exactly this list (adding and removing are
   * both "send the list you want"). Empty = back to plain-HTTP IP access
   * only. Hostnames are case-insensitive; the daemon lowercases and dedups.
   */
  domains: z.array(ingressDomainSchema),
});

export type SetIngressRequest = z.infer<typeof setIngressRequestSchema>;

export const setIngressResponseSchema = z.object({
  /**
   * The domains now written into the proxy config (normalized). Certificate
   * issuance happens after this returns — poll getIngress to watch each one
   * converge.
   */
  domains: z.array(z.string()),
});

export type SetIngressResponse = z.infer<typeof setIngressResponseSchema>;

/**
 * Live observations about a bound domain, measured at request time — never
 * cached, never invented. Both can be honestly red while the operator's DNS
 * record propagates; Caddy retries certificate issuance on its own, so a
 * red probe needs no action beyond fixing what it names.
 */
export const ingressProbeSchema = z.object({
  /** What the domain resolves to right now; empty = no record yet. */
  dnsAddresses: z.array(z.string()),
  /** Resolver failure (timeout, SERVFAIL) — distinct from "no record". */
  dnsError: z.string().nullable(),
  /**
   * Whether the local proxy serves a valid trusted certificate for the
   * domain (a TLS handshake against 127.0.0.1:443 with the domain as SNI).
   * Proves issuance, not public reachability — a cloud security group can
   * still block 443 from outside, which no probe from this host can see.
   */
  tlsOk: z.boolean(),
  tlsError: z.string().nullable(),
});

export type IngressProbe = z.infer<typeof ingressProbeSchema>;

export const ingressDomainStatusSchema = z.object({
  domain: z.string(),
  probe: ingressProbeSchema,
});

export type IngressDomainStatus = z.infer<typeof ingressDomainStatusSchema>;

export const getIngressResponseSchema = z.object({
  /**
   * Whether this daemon manages a proxy config at all
   * (DORMICE_INGRESS_FILE set). False = the whole feature is honestly
   * absent; binding attempts are refused with the reason.
   */
  managed: z.boolean(),
  /** Every bound domain with its live probes; empty when none are bound. */
  domains: z.array(ingressDomainStatusSchema),
});

export type GetIngressResponse = z.infer<typeof getIngressResponseSchema>;
