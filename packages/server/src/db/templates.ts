import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { sandboxes, type TemplateRow, templates } from './schema';
import { readRuntimeSettings } from './settings';

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
 * The image a template-less sandbox boots from, as this node resolves it:
 * the fleet's base image from the copy (shared settings.ts baseImage — a
 * fleet setting since the fourth cut, 2026-09-15), or, while the fleet
 * names none, the node's own DORMICE_BASE_IMAGE — the knob's old home,
 * kept as the fallback so a node upgraded before its gateway learned the
 * knob keeps building sandboxes (main.ts warns about the fallback at
 * boot). Neither is a refusal that says where to set it: a sandbox built
 * from a guessed image would be the wrong sandbox. The executors consult
 * this through their baseImage closure (main.ts), read at each birth —
 * the same live-view shape as the resource knobs, so a console edit
 * reaches the next birth without a restart.
 */
export function resolveBaseImage(
  db: Db,
  envFallback: string | undefined,
): string {
  const fleet = readRuntimeSettings(db).baseImage;
  if (fleet !== null) return fleet;
  if (envFallback !== undefined) return envFallback;
  throw new Error(
    'no base image: the fleet settings name none and DORMICE_BASE_IMAGE is not set on this node — set baseImage at the gateway (console › settings, or DORMICE_BASE_IMAGE in its gateway.env before its first start)',
  );
}

/**
 * The single arbiter turning a sandbox row's template into the image its
 * next shell boots. Null means the base image — expressed as undefined so
 * the executor resolves it through its own live view (resolveBaseImage
 * above, wired in main.ts). A registered name resolves to the template's
 * *current* image; a missing row means the removal guard was bypassed (a
 * template removed while this node was out of the fleet), which is worth
 * an honest crash, not a silent fallback to the wrong image.
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
