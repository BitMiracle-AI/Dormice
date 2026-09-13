import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The gateway's tables are "how the fleet is configured and who may
 * enter" — never a sandbox's state, which lives in the ledger of the node
 * that runs it and is asked for when needed (find.ts). One table today;
 * api_keys, settings, templates and console_account arrive here with the
 * configuration authority.
 */

/**
 * Every node that has ever checked in (routes/nodes.ts): its id, the
 * address the gateway forwards to, and when it first appeared. Written by
 * the nodes themselves at their first check-in — there is no registration
 * verb and no nodes file, so "which nodes exist" has exactly one home —
 * and deleted only by an operator's removeNode. Persistent, not memory,
 * for one reason: a node that is down must still be known after a gateway
 * restart, or a name that lives only there would be placed anew elsewhere
 * and come back as a conflict when the node returns. Everything the node
 * last reported (its reading, build, check-in time) is memory: fifteen
 * seconds later it is reported again.
 */
export const nodes = sqliteTable('nodes', {
  /** DORMICE_NODE_ID as the node states it — the `nodeId` in every sandbox answer. */
  id: text('id').primaryKey(),
  /** Where the gateway forwards to; updated when a check-in states a new one. */
  endpoint: text('endpoint').notNull(),
  /** ISO 8601 UTC — the first check-in. */
  addedAt: text('added_at').notNull(),
});

export type NodeRow = typeof nodes.$inferSelect;
