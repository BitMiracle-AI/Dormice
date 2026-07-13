import {
  Dormice,
  type ReadFileResult,
  type Sandbox,
  type Template,
} from '@dormice/sdk';

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
  { header: 'USER KEY', value: (s) => s.externalId },
  { header: 'STATE', value: (s) => s.state },
  { header: 'SANDBOX ID', value: (s) => s.sandboxId },
  { header: 'LAST ACTIVE', value: (s) => s.lastActiveAt },
];

/**
 * The protocol keeps externalId opaque, so a hostile key can carry control
 * characters — printed raw, ESC sequences would let one sandbox's name
 * rewrite the operator's terminal. Neutralized here, at the output layer,
 * where the terminal risk lives.
 */
function printable(value: string): string {
  return value.replace(/\p{Cc}/gu, '?');
}

/** Plain-column rendering shared by the ls verbs. Cells must be printable already. */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/** `dor sandbox ls`: every sandbox with its lifecycle state, as plain columns. */
export async function sandboxLs(client: Dormice): Promise<string> {
  const sandboxes = await client.listSandboxes();
  if (sandboxes.length === 0) {
    return 'No sandboxes.';
  }
  return renderTable(
    COLUMNS.map((column) => column.header),
    sandboxes.map((s) => COLUMNS.map((column) => printable(column.value(s)))),
  );
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * `dor sandbox exec <externalId> <command>`: run a shell command in the
 * sandbox, buffered. Three channels instead of one string: the command's
 * stdout and stderr must reach the operator's matching streams untouched
 * (this is their own command's output, like ssh — unlike the ls table,
 * where a hostile key could rewrite the terminal), and the exit code must
 * come back as the process's own.
 */
export async function sandboxExec(
  client: Dormice,
  externalId: string,
  command: string,
  timeoutSeconds?: number,
): Promise<ExecOutput> {
  const result = await client.execCommand(externalId, command, {
    timeoutSeconds,
  });
  let stderr = result.stderr;
  if (result.stdoutTruncated) stderr += 'dor: stdout truncated at 1 MiB\n';
  if (result.stderrTruncated) stderr += 'dor: stderr truncated at 1 MiB\n';
  return { stdout: result.stdout, stderr, exitCode: result.exitCode };
}

/**
 * `dor sandbox push <externalId> <localPath> [remotePath]`: one local file into
 * the sandbox. The bytes arrive here already read — main.ts owns the
 * filesystem, this function owns the API call and the message.
 */
export async function sandboxPush(
  client: Dormice,
  externalId: string,
  content: Uint8Array,
  remotePath: string,
): Promise<string> {
  const { files } = await client.writeFiles(externalId, [
    { path: remotePath, content },
  ]);
  const written = files[0]?.path ?? remotePath;
  return `Wrote ${printable(written)} (${content.length} bytes).`;
}

/**
 * `dor sandbox pull <externalId> <remotePath> [localPath]`: one file out of the
 * sandbox. Returns the exact bytes; main.ts decides between a local file and
 * raw stdout — raw on purpose, the same rule as exec output: these are the
 * operator's own bytes, not a place to strip control characters.
 */
export async function sandboxPull(
  client: Dormice,
  externalId: string,
  remotePath: string,
): Promise<ReadFileResult> {
  return client.readFile(externalId, remotePath);
}

/** The message printed instead of raw bytes when pull saves to a local file. */
export function pullSavedMessage(
  result: ReadFileResult,
  localPath: string,
): string {
  return `Pulled ${printable(result.path)} -> ${localPath} (${result.content.length} bytes).`;
}

/**
 * `dor sandbox rebuild <externalId>`: swap the sandbox's container, keep its
 * disk. /home/user survives; everything else resets onto the current image
 * of the sandbox's template (or the base image) at the next use.
 */
export async function sandboxRebuild(
  client: Dormice,
  externalId: string,
): Promise<string> {
  const { sandbox } = await client.rebuildSandbox(externalId);
  const target = sandbox.template
    ? `template "${printable(sandbox.template)}"'s current image`
    : 'the current base image';
  return (
    `Rebuilt the sandbox for key "${printable(externalId)}" — /home/user kept, ` +
    `now ${sandbox.state}; its next use starts on ${target}.`
  );
}

/** `dor sandbox destroy <externalId>`: destroy the sandbox behind a key, idempotently. */
export async function sandboxDestroy(
  client: Dormice,
  externalId: string,
): Promise<string> {
  const { destroyed } = await client.destroySandbox(externalId);
  return destroyed
    ? `Destroyed the sandbox for key "${printable(externalId)}".`
    : `No sandbox for key "${printable(externalId)}" — nothing to destroy.`;
}

/**
 * `dor template add <name> <image>`: name a Docker image on the daemon's
 * host as a template. An upsert — re-adding a name re-points it, which is
 * how a template is upgraded; existing sandboxes move on their next rebuild.
 */
export async function templateAdd(
  client: Dormice,
  name: string,
  image: string,
): Promise<string> {
  const { template } = await client.registerTemplate(name, image);
  return `Registered template "${printable(template.name)}" -> ${printable(template.image)}.`;
}

/** `dor template ls`: every registered template, as plain columns. */
export async function templateLs(client: Dormice): Promise<string> {
  const templates = await client.listTemplates();
  if (templates.length === 0) {
    return 'No templates.';
  }
  const columns: { header: string; value: (t: Template) => string }[] = [
    { header: 'NAME', value: (t) => t.name },
    { header: 'IMAGE', value: (t) => t.image },
    { header: 'CREATED', value: (t) => t.createdAt },
  ];
  return renderTable(
    columns.map((column) => column.header),
    templates.map((t) => columns.map((column) => printable(column.value(t)))),
  );
}

/** `dor template rm <name>`: drop a template's registration (never the image), idempotently. */
export async function templateRm(
  client: Dormice,
  name: string,
): Promise<string> {
  const { removed } = await client.removeTemplate(name);
  return removed
    ? `Removed template "${printable(name)}".`
    : `No template named "${printable(name)}" — nothing to remove.`;
}
