import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { sandboxes, type TemplateRow, templates } from './schema';

/**
 * Readers over the node's copy of the templates table (schema.ts). The
 * writers live at the gateway — registerTemplate re-points a name, the
 * template upgrade front door; removeTemplate asks every node first — and
 * the copy is replaced whole with each bundle (db/settings.ts
 * applyNodeConfig). Nothing on the node edits a template.
 */

export function findTemplate(db: Db, name: string): TemplateRow | undefined {
  return db.select().from(templates).where(eq(templates.name, name)).get();
}

/**
 * Names of sandboxes still created from this template — the node's answer
 * to the gateway's templateUsers question: removal is refused at the
 * gateway while any node names one, so wakes never resolve a dangling name.
 */
export function sandboxNamesUsingTemplate(db: Db, name: string): string[] {
  return db
    .select({ name: sandboxes.name })
    .from(sandboxes)
    .where(eq(sandboxes.template, name))
    .all()
    .map((row) => row.name);
}

/**
 * The single arbiter turning a sandbox row's template into the image its
 * next shell boots. Null means the base image — expressed as undefined so
 * the executor falls back to its own configured default. A registered name
 * resolves to the template's *current* image; a missing row means the
 * removal guard was bypassed (a template removed while this node was out
 * of the fleet), which is worth an honest crash, not a silent fallback to
 * the wrong image.
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
