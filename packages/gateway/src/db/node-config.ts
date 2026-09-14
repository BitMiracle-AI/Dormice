import type { NodeConfigBundle } from '@dormice/shared';
import type { Db } from './db';
import { readConfigVersion, readS3Settings, readSettings } from './settings';
import { listTemplates } from './templates';

/**
 * The bundle a node applies (shared nodeConfigBundleSchema): the settings
 * row with the store's keys, the node's own row, every template — read
 * back to back on one synchronous connection, so a node never receives
 * one version's number with another version's content (nothing runs
 * between two better-sqlite3 statements in the same tick).
 */
export function readNodeConfig(
  db: Db,
  node: { swapGb: number },
): NodeConfigBundle {
  const settings = readSettings(db);
  return {
    version: readConfigVersion(db),
    settings: {
      sandboxDefaults: settings.sandboxDefaults,
      defaultPolicy: settings.defaultPolicy,
      s3: readS3Settings(db),
      sandboxDomain: settings.sandboxDomain,
      sandboxDomainAliases: settings.sandboxDomainAliases,
      pidsLimit: settings.pidsLimit,
    },
    node: { swapGb: node.swapGb },
    templates: listTemplates(db),
  };
}
