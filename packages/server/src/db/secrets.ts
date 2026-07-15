import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { daemonSecrets } from './schema';

/**
 * The daemon's signing secret (see the schema comment for why it is not
 * the API token). A singleton like the console account; born on the first
 * daemon start after the migration, then permanent — no verb regenerates
 * it, so callers may read it once at startup.
 *
 * Losing the ledger loses the secret and with it every in-flight envd
 * token and signed URL — the right outcome, since it also loses the
 * sandboxes those credentials pointed at.
 */
const SECRETS_ID = 1;

export function getOrCreateSigningSecret(db: Db): string {
  const existing = db
    .select()
    .from(daemonSecrets)
    .where(eq(daemonSecrets.id, SECRETS_ID))
    .get();
  if (existing) {
    return existing.envdSigningSecret;
  }
  const secret = randomBytes(32).toString('hex');
  // Synchronous better-sqlite3 + the ledger's exclusive lock: no second
  // writer can race this insert into a duplicate.
  db.insert(daemonSecrets)
    .values({
      id: SECRETS_ID,
      envdSigningSecret: secret,
      createdAt: new Date().toISOString(),
    })
    .run();
  return secret;
}
