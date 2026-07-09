import { Dormice, type ReadFileResult, type Sandbox } from '@dormice/sdk';

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

/**
 * The protocol keeps userKey opaque, so a hostile key can carry control
 * characters — printed raw, ESC sequences would let one sandbox's name
 * rewrite the operator's terminal. Neutralized here, at the output layer,
 * where the terminal risk lives.
 */
function printable(value: string): string {
  return value.replace(/\p{Cc}/gu, '?');
}

/** `dor sandbox ls`: every sandbox with its lifecycle state, as plain columns. */
export async function sandboxLs(client: Dormice): Promise<string> {
  const sandboxes = await client.listSandboxes();
  if (sandboxes.length === 0) {
    return 'No sandboxes.';
  }
  const cell = (column: (typeof COLUMNS)[number], s: Sandbox) =>
    printable(column.value(s));
  const widths = COLUMNS.map((column) =>
    Math.max(
      column.header.length,
      ...sandboxes.map((s) => cell(column, s).length),
    ),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    line(COLUMNS.map((column) => column.header)),
    ...sandboxes.map((s) => line(COLUMNS.map((column) => cell(column, s)))),
  ].join('\n');
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * `dor sandbox exec <userKey> <command>`: run a shell command in the
 * sandbox, buffered. Three channels instead of one string: the command's
 * stdout and stderr must reach the operator's matching streams untouched
 * (this is their own command's output, like ssh — unlike the ls table,
 * where a hostile key could rewrite the terminal), and the exit code must
 * come back as the process's own.
 */
export async function sandboxExec(
  client: Dormice,
  userKey: string,
  command: string,
  timeoutSeconds?: number,
): Promise<ExecOutput> {
  const result = await client.execCommand(userKey, command, {
    timeoutSeconds,
  });
  let stderr = result.stderr;
  if (result.stdoutTruncated) stderr += 'dor: stdout truncated at 1 MiB\n';
  if (result.stderrTruncated) stderr += 'dor: stderr truncated at 1 MiB\n';
  return { stdout: result.stdout, stderr, exitCode: result.exitCode };
}

/**
 * `dor sandbox push <userKey> <localPath> [remotePath]`: one local file into
 * the sandbox. The bytes arrive here already read — main.ts owns the
 * filesystem, this function owns the API call and the message.
 */
export async function sandboxPush(
  client: Dormice,
  userKey: string,
  content: Uint8Array,
  remotePath: string,
): Promise<string> {
  const { files } = await client.writeFiles(userKey, [
    { path: remotePath, content },
  ]);
  const written = files[0]?.path ?? remotePath;
  return `Wrote ${printable(written)} (${content.length} bytes).`;
}

/**
 * `dor sandbox pull <userKey> <remotePath> [localPath]`: one file out of the
 * sandbox. Returns the exact bytes; main.ts decides between a local file and
 * raw stdout — raw on purpose, the same rule as exec output: these are the
 * operator's own bytes, not a place to strip control characters.
 */
export async function sandboxPull(
  client: Dormice,
  userKey: string,
  remotePath: string,
): Promise<ReadFileResult> {
  return client.readFile(userKey, remotePath);
}

/** The message printed instead of raw bytes when pull saves to a local file. */
export function pullSavedMessage(
  result: ReadFileResult,
  localPath: string,
): string {
  return `Pulled ${printable(result.path)} -> ${localPath} (${result.content.length} bytes).`;
}

/** `dor sandbox release <userKey>`: destroy the sandbox behind a key, idempotently. */
export async function sandboxRelease(
  client: Dormice,
  userKey: string,
): Promise<string> {
  const { released } = await client.releaseSandbox(userKey);
  return released
    ? `Released the sandbox for key "${printable(userKey)}".`
    : `No sandbox for key "${printable(userKey)}" — nothing to release.`;
}
