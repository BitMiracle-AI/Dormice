import { Dormice, type Sandbox } from '@dormice/sdk';

/**
 * Builds the API client from the environment. The daemon's address and
 * token are the CLI's only configuration; a missing variable is named
 * right here instead of surfacing later as a confusing network error.
 */
export function clientFromEnv(
  env: Record<string, string | undefined>,
): Dormice {
  const endpoint = env.DORMICE_ENDPOINT;
  const token = env.DORMICE_API_TOKEN;
  if (!endpoint || !token) {
    const missing = [
      !endpoint && 'DORMICE_ENDPOINT',
      !token && 'DORMICE_API_TOKEN',
    ]
      .filter(Boolean)
      .join(' and ');
    throw new Error(
      `${missing} must be set, e.g.\n` +
        '  export DORMICE_ENDPOINT=http://127.0.0.1:3676\n' +
        "  export DORMICE_API_TOKEN=<the daemon's token>",
    );
  }
  return new Dormice({ endpoint, token });
}

const COLUMNS: { header: string; value: (s: Sandbox) => string }[] = [
  { header: 'USER KEY', value: (s) => s.userKey },
  { header: 'STATE', value: (s) => s.state },
  { header: 'SANDBOX ID', value: (s) => s.sandboxId },
  { header: 'LAST ACTIVE', value: (s) => s.lastActiveAt },
];

/** `dor sandbox ls`: every sandbox with its lifecycle state, as plain columns. */
export async function sandboxLs(client: Dormice): Promise<string> {
  const sandboxes = await client.listSandboxes();
  if (sandboxes.length === 0) {
    return 'No sandboxes.';
  }
  const widths = COLUMNS.map((column) =>
    Math.max(
      column.header.length,
      ...sandboxes.map((s) => column.value(s).length),
    ),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    line(COLUMNS.map((column) => column.header)),
    ...sandboxes.map((s) => line(COLUMNS.map((column) => column.value(s)))),
  ].join('\n');
}

/** `dor sandbox release <userKey>`: destroy the sandbox behind a key, idempotently. */
export async function sandboxRelease(
  client: Dormice,
  userKey: string,
): Promise<string> {
  const { released } = await client.releaseSandbox(userKey);
  return released
    ? `Released the sandbox for key "${userKey}".`
    : `No sandbox for key "${userKey}" — nothing to release.`;
}
