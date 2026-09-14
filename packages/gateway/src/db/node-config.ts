import type { NodeConfigBundle } from '@dormice/shared';
import type { Db } from './db';
import { readSettingsForBundle } from './settings';
import { listTemplates } from './templates';

/**
 * The bundle a node applies (shared nodeConfigBundleSchema): the settings
 * row — version, knobs and the store's keys from one read — the node's
 * own row, every template; the two statements run back to back on one
 * synchronous connection, so a node never receives one version's number
 * with another version's content (nothing runs between two better-sqlite3
 * statements in the same tick).
 */
export function readNodeConfig(
  db: Db,
  node: { swapGb: number },
): NodeConfigBundle {
  const { version, settings, s3 } = readSettingsForBundle(db);
  return {
    version,
    settings: {
      sandboxDefaults: settings.sandboxDefaults,
      defaultPolicy: settings.defaultPolicy,
      s3,
      sandboxDomain: settings.sandboxDomain,
      sandboxDomainAliases: settings.sandboxDomainAliases,
      pidsLimit: settings.pidsLimit,
    },
    node: { swapGb: node.swapGb },
    templates: listTemplates(db),
  };
}
