import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { sandboxes, type TemplateRow, templates } from './schema';

/**
 * Upsert: registering an existing name re-points it at the new image. That
 * is the template upgrade front door — build a new image, re-register the
 * name, then rebuildSandbox the stock that should move onto it.
 */
export function registerTemplate(
  db: Db,
  input: { name: string; image: string },
): TemplateRow {
  const row: TemplateRow = {
    name: input.name,
    image: input.image,
    createdAt: new Date().toISOString(),
  };
  db.insert(templates)
    .values(row)
    .onConflictDoUpdate({
      target: templates.name,
      set: { image: input.image },
    })
    .run();
  // Re-read instead of returning the literal: an upsert on an existing name
  // keeps its original createdAt.
  const stored = findTemplate(db, input.name);
  if (!stored) {
    throw new Error(`template ${input.name} vanished mid-register`);
  }
  return stored;
}

export function listTemplates(db: Db): TemplateRow[] {
  return db.select().from(templates).all();
}

export function findTemplate(db: Db, name: string): TemplateRow | undefined {
  return db.select().from(templates).where(eq(templates.name, name)).get();
}

/** Returns true when a row existed and was removed. */
export function removeTemplate(db: Db, name: string): boolean {
  const existed = findTemplate(db, name) !== undefined;
  db.delete(templates).where(eq(templates.name, name)).run();
  return existed;
}

/**
 * User keys of sandboxes still created from this template — removal is
 * refused while this is non-empty, so wakes never resolve a dangling name.
 */
export function sandboxKeysUsingTemplate(db: Db, name: string): string[] {
  return db
    .select({ userKey: sandboxes.userKey })
    .from(sandboxes)
    .where(eq(sandboxes.template, name))
    .all()
    .map((row) => row.userKey);
}

/**
 * The single arbiter turning a sandbox row's template into the image its
 * next shell boots. Null means the base image — expressed as undefined so
 * the executor falls back to its own configured default. A registered name
 * resolves to the template's *current* image; a missing row means the
 * removal guard was bypassed (ledger drift), which is worth an honest crash,
 * not a silent fallback to the wrong image.
 */
export function resolveImage(
  db: Db,
  template: string | null,
): string | undefined {
  if (template === null) {
    return undefined;
  }
  const row = findTemplate(db, template);
  if (!row) {
    throw new Error(`template '${template}' is not registered`);
  }
  return row.image;
}
