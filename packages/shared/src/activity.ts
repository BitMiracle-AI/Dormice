import { z } from 'zod';

/**
 * listActivity() — the ledger's recent history: who was created, cooled,
 * woken, destroyed, and what reconciliation repaired. Events come from the
 * daemon's own actors (lifecycle moves, the idle scanner, the reconciler,
 * the archiver) and live in a bounded ring in SQLite — the newest N are
 * kept, older ones fall off. This is an explanation window, not an audit
 * log and not a monitoring system: it answers "why is my sandbox stopped",
 * not "prove nobody touched it".
 */
export const ACTIVITY_KINDS = [
  'created',
  'woken',
  'frozen',
  'stopped',
  'rebuilt',
  'destroyed',
  /** An E2B deadline with the kill action passed: destroyed, disk and all. */
  'expired-killed',
  'archived',
  'restore-started',
  'restored',
  'restore-failed',
  /** The reconciler corrected the ledger (or reality) to match the other. */
  'reconciled',
  /** updatePolicy rewrote a sandbox's lifecycle thresholds (ledger-only). */
  'policy-changed',
  /** updateMetadata replaced a sandbox's label set (ledger-only). */
  'metadata-changed',
  'daemon-started',
  /** An operator bound or cleared the console domain through setIngress. */
  'ingress-updated',
  /** An operator minted an API key (createApiKey). The token itself is never logged. */
  'apikey-created',
  /** updateApiKey changed a key's name or expiry; the detail names what moved. */
  'apikey-updated',
  /** An operator parked an API key (updateApiKey disabled) — reversible, unlike revoke. */
  'apikey-disabled',
  /** An operator resumed a parked API key — the credential opens doors again. */
  'apikey-enabled',
  /** An operator revoked an API key (revokeApiKey) — the credential died here. */
  'apikey-revoked',
  /**
   * An operator launched the one-click self-upgrade (applyUpgrade). Only
   * the launch is recorded — the outcome lives in getUpgradeStatus, and
   * the daemon that would record "finished" is the one being replaced.
   */
  'upgrade-started',
] as const;

export const activityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof activityKindSchema>;

/**
 * Attribution: which credential asked for the recorded action. A closed
 * vocabulary, built and parsed only here so the string shapes cannot drift
 * between the daemon (which writes them) and the console (which displays
 * them):
 *
 *   'env-token'    — the bootstrap credential (DORMICE_API_TOKEN).
 *   'console'      — a console session; the human at the web console.
 *   'apikey:<id>'  — a ledger API key. By id, not name: names became
 *                    renameable, ids are the stable handle (the sandbox
 *                    name/id doctrine), and revoked rows are never deleted,
 *                    so an id always resolves back to a display name.
 *   null           — no credential asked: the daemon's own actors (idle
 *                    scanner, reconciler, archiver, startup) and data-plane
 *                    wakes that carry no ledger credential (the sandbox
 *                    port proxy, envd operations). Rows written before
 *                    attribution existed are also null; the ring prunes
 *                    them away within days.
 *
 * This attributes the explanation window, nothing more: lifecycle verbs
 * name their actor, but exec and file traffic never enter the ring (they
 * would flush it in minutes), so "which key ran what command" needs a real
 * audit log, which this deliberately is not.
 */
export const ENV_TOKEN_ACTOR = 'env-token';
export const CONSOLE_ACTOR = 'console';
const APIKEY_ACTOR_PREFIX = 'apikey:';

export function apiKeyActor(id: string): string {
  return `${APIKEY_ACTOR_PREFIX}${id}`;
}

/** The id inside an 'apikey:<id>' actor, null for every other actor shape. */
export function apiKeyActorId(actor: string | null): string | null {
  return actor?.startsWith(APIKEY_ACTOR_PREFIX)
    ? actor.slice(APIKEY_ACTOR_PREFIX.length)
    : null;
}

export const activityEventSchema = z.object({
  /** Ring position; monotonically increasing, newest is largest. */
  id: z.number().int(),
  /** ISO 8601 UTC. */
  at: z.string(),
  kind: activityKindSchema,
  /**
   * Null for events with no owning sandbox (orphan sweeps, daemon start).
   * Prefixed because they reference another entity: a bare `name` here
   * would read as the event's own name (`id` above already is its own).
   */
  sandboxName: z.string().nullable(),
  sandboxId: z.string().nullable(),
  /** Who asked — the closed actor vocabulary above; null = the daemon itself. */
  actor: z.string().nullable(),
  /** One short line of context: which threshold, what was repaired, what changed. */
  detail: z.string(),
});

export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const listActivityRequestSchema = z.object({
  /** Newest-first page size; the ring never holds more than its bound anyway. */
  limit: z.number().int().min(1).max(1000).default(200),
});

export type ListActivityRequest = z.input<typeof listActivityRequestSchema>;

export const listActivityResponseSchema = z.object({
  /** Newest first. */
  events: z.array(activityEventSchema),
});

export type ListActivityResponse = z.infer<typeof listActivityResponseSchema>;
