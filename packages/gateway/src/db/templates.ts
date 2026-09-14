import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { type TemplateRow, templates } from './schema';
import { bumpConfigVersion } from './settings';

/**
 * Upsert: registering an existing name re-points it at the new image. That
 * is the template upgrade front door — build a new image, re-register the
 * name, then rebuildSandbox the stock that should move onto it; every
 * node hears of the change at its next check-in (the version counts up in
 * the same transaction as the write).
 *
 * updatedAt is the upgrade timestamp: stamped only when the image actually
 * changes. A re-register of the same image writes nothing at all — the
 * timestamp must not claim an upgrade that did not happen, and the nodes
 * are not told about a change that is none.
 */
export function registerTemplate(
  db: Db,
  input: { name: string; image: string },
): TemplateRow {
  const now = new Date().toISOString();
  const existing = findTemplate(db, input.name);
  if (existing?.image === input.image) {
    return existing;
  }
  return db.transaction((tx) => {
    if (!existing) {
      const row: TemplateRow = {
        name: input.name,
        image: input.image,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(templates).values(row).run();
      bumpConfigVersion(tx);
      return row;
    }
    tx.update(templates)
      .set({ image: input.image, updatedAt: now })
      .where(eq(templates.name, input.name))
      .run();
    bumpConfigVersion(tx);
    return { ...existing, image: input.image, updatedAt: now };
  });
}

export function listTemplates(db: Db): TemplateRow[] {
  return db.select().from(templates).orderBy(templates.name).all();
}

export function findTemplate(db: Db, name: string): TemplateRow | undefined {
  return db.select().from(templates).where(eq(templates.name, name)).get();
}

/** Returns true when a row existed and was removed; the version counts up only then. */
export function removeTemplate(db: Db, name: string): boolean {
  if (findTemplate(db, name) === undefined) return false;
  db.transaction((tx) => {
    tx.delete(templates).where(eq(templates.name, name)).run();
    bumpConfigVersion(tx);
  });
  return true;
}
