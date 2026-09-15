import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireSingleWriterLock } from '@dormice/server/lock';
import { z } from 'zod';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { importNodeLedger, parseEnvFile } from './import-ledger';

/**
 * `node dist/import.js --node-db <ledger> --node-env <env file>` — the
 * one-time import of a single machine's ledger into the gateway's
 * database (import-ledger.ts has what and why), run by install.sh on the
 * gateway's machine before the gateway's first start. The gateway's own
 * configuration comes from the environment, as for the gateway itself
 * (install.sh sources gateway.env): DORMICE_GATEWAY_DB_PATH says where
 * to write, the fleet seeds fill what the node's row does not say.
 *
 * Exit 0 with the counts as JSON on stdout; 2 when the gateway's
 * settings row exists (nothing written); 1 for everything else, one
 * line on stderr. No value of any row is ever printed.
 */
const USAGE =
  'usage: import.js --node-db <path to dormice.db> --node-env <path to /etc/dormice/env>';

function parseArgs(argv: string[]): { nodeDb: string; nodeEnv: string } {
  let nodeDb: string | undefined;
  let nodeEnv: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--node-db') nodeDb = argv[++i];
    else if (arg?.startsWith('--node-db='))
      nodeDb = arg.slice('--node-db='.length);
    else if (arg === '--node-env') nodeEnv = argv[++i];
    else if (arg?.startsWith('--node-env='))
      nodeEnv = arg.slice('--node-env='.length);
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (!nodeDb || !nodeEnv) throw new Error(USAGE);
  return { nodeDb, nodeEnv };
}

function main(): number {
  const { nodeDb, nodeEnv } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (config.DORMICE_GATEWAY_DB_PATH === ':memory:') {
    throw new Error(
      'DORMICE_GATEWAY_DB_PATH is :memory: — an import needs the gateway database file the gateway will start on',
    );
  }
  // The gateway's own lock over its file: an import under a running
  // gateway's feet would hand it a settings row it never saw.
  const lock = acquireSingleWriterLock(
    config.DORMICE_GATEWAY_DB_PATH,
    `a gateway is running against ${config.DORMICE_GATEWAY_DB_PATH} — stop it (systemctl stop dormice-gateway) before importing`,
  );
  try {
    const db = openDb(config.DORMICE_GATEWAY_DB_PATH);
    migrateDb(db, fileURLToPath(new URL('../drizzle', import.meta.url)));
    const outcome = importNodeLedger(db, config, {
      nodeDbPath: nodeDb,
      nodeEnv: parseEnvFile(readFileSync(nodeEnv, 'utf8')),
    });
    if (outcome.code === 2) {
      process.stderr.write(`${outcome.message}\n`);
      return 2;
    }
    process.stdout.write(`${JSON.stringify(outcome.counts)}\n`);
    return 0;
  } finally {
    lock.close();
  }
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `import.js: ${
      error instanceof z.ZodError
        ? z.prettifyError(error)
        : error instanceof Error
          ? error.message
          : String(error)
    }\n`,
  );
  process.exitCode = 1;
}
