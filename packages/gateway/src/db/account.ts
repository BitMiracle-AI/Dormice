import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { type ConsoleAccountRow, consoleAccount } from './schema';

/**
 * The console's single human account (see the schema comment for why it is
 * a singleton). The fixed id makes setup an upsert: presenting the API
 * token overwrites whatever is there — account creation, password change
 * and forgot-password are all the same verb.
 */
const ACCOUNT_ID = 1;

export function getConsoleAccount(db: Db): ConsoleAccountRow | undefined {
  return db
    .select()
    .from(consoleAccount)
    .where(eq(consoleAccount.id, ACCOUNT_ID))
    .get();
}

export function setConsoleAccount(
  db: Db,
  input: { username: string; passwordHash: string; sessionSecret: string },
): ConsoleAccountRow {
  const now = new Date().toISOString();
  const row: ConsoleAccountRow = {
    id: ACCOUNT_ID,
    username: input.username,
    passwordHash: input.passwordHash,
    sessionSecret: input.sessionSecret,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(consoleAccount)
    .values(row)
    .onConflictDoUpdate({
      target: consoleAccount.id,
      set: {
        username: input.username,
        passwordHash: input.passwordHash,
        sessionSecret: input.sessionSecret,
        updatedAt: now,
      },
    })
    .run();
  const stored = getConsoleAccount(db);
  if (!stored) {
    throw new Error('console account vanished mid-setup');
  }
  return stored;
}
