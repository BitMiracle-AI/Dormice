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
  /**
   * An operator launched the one-click self-upgrade (applyUpgrade). Only
   * the launch is recorded — the outcome lives in getUpgradeStatus, and
   * the daemon that would record "finished" is the one being replaced.
   */
  'upgrade-started',
] as const;

export const activityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const activityEventSchema = z.object({
  /** Ring position; monotonically increasing, newest is largest. */
  id: z.number().int(),
  /** ISO 8601 UTC. */
  at: z.string(),
  kind: activityKindSchema,
  /** Null for events with no owning sandbox (orphan sweeps, daemon start). */
  externalId: z.string().nullable(),
  sandboxId: z.string().nullable(),
  /** One short line of context: which actor, which threshold, what was repaired. */
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
