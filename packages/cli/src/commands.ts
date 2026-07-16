import {
  type ApiKey,
  apiKeyStatus,
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

/** One line per label set, `k=v,k=v`; shared by ls and meta. */
function formatMetadata(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

const COLUMNS: { header: string; value: (s: Sandbox) => string }[] = [
  { header: 'NAME', value: (s) => s.name },
  { header: 'STATE', value: (s) => s.state },
  { header: 'ID', value: (s) => s.id },
  { header: 'LAST ACTIVE', value: (s) => s.lastActiveAt },
  { header: 'METADATA', value: (s) => formatMetadata(s.metadata) },
];

/**
 * The protocol keeps name opaque, so a hostile key can carry control
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

/**
 * Parses `key=value` label arguments for `dor sandbox meta`. Split on the
 * FIRST `=` only — values may contain `=` (base64, URLs), keys may not.
 */
export function parseLabels(args: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq <= 0) {
      throw new Error(
        `label "${arg}" is not key=value — e.g. dor sandbox meta my-key app=crawler env=prod`,
      );
    }
    labels[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return labels;
}

/**
 * `dor sandbox meta <name> [key=value ...]`: no labels = show the
 * current set; labels (or --clear) = full replacement, the verb's wire
 * semantics stated plainly. A pure ledger write — nothing is woken.
 */
export async function sandboxMeta(
  client: Dormice,
  name: string,
  labels: Record<string, string> | null,
): Promise<string> {
  if (labels === null) {
    // Read path: the native list is the one read the daemon offers.
    const sandbox = (await client.listSandboxes()).find((s) => s.name === name);
    if (!sandbox) {
      throw new Error(`no sandbox named "${name}" — acquire it first`);
    }
    const line = formatMetadata(sandbox.metadata);
    return line ? printable(line) : 'No metadata.';
  }
  const { sandbox } = await client.updateMetadata(name, labels);
  const line = formatMetadata(sandbox.metadata);
  return line
    ? `Metadata of "${printable(name)}" is now ${printable(line)}.`
    : `Cleared metadata of "${printable(name)}".`;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * `dor sandbox exec <name> <command>`: run a shell command in the
 * sandbox, buffered. Three channels instead of one string: the command's
 * stdout and stderr must reach the operator's matching streams untouched
 * (this is their own command's output, like ssh — unlike the ls table,
 * where a hostile key could rewrite the terminal), and the exit code must
 * come back as the process's own.
 */
export async function sandboxExec(
  client: Dormice,
  name: string,
  command: string,
  timeoutSeconds?: number,
): Promise<ExecOutput> {
  const result = await client.execCommand(name, command, {
    timeoutSeconds,
  });
  let stderr = result.stderr;
  if (result.stdoutTruncated) stderr += 'dor: stdout truncated at 1 MiB\n';
  if (result.stderrTruncated) stderr += 'dor: stderr truncated at 1 MiB\n';
  return { stdout: result.stdout, stderr, exitCode: result.exitCode };
}

/**
 * `dor sandbox push <name> <localPath> [remotePath]`: one local file into
 * the sandbox. The bytes arrive here already read — main.ts owns the
 * filesystem, this function owns the API call and the message.
 */
export async function sandboxPush(
  client: Dormice,
  name: string,
  content: Uint8Array,
  remotePath: string,
): Promise<string> {
  const { files } = await client.writeFiles(name, [
    { path: remotePath, content },
  ]);
  const written = files[0]?.path ?? remotePath;
  return `Wrote ${printable(written)} (${content.length} bytes).`;
}

/**
 * `dor sandbox pull <name> <remotePath> [localPath]`: one file out of the
 * sandbox. Returns the exact bytes; main.ts decides between a local file and
 * raw stdout — raw on purpose, the same rule as exec output: these are the
 * operator's own bytes, not a place to strip control characters.
 */
export async function sandboxPull(
  client: Dormice,
  name: string,
  remotePath: string,
): Promise<ReadFileResult> {
  return client.readFile(name, remotePath);
}

/** The message printed instead of raw bytes when pull saves to a local file. */
export function pullSavedMessage(
  result: ReadFileResult,
  localPath: string,
): string {
  return `Pulled ${printable(result.path)} -> ${localPath} (${result.content.length} bytes).`;
}

/**
 * `dor sandbox rebuild <name>`: swap the sandbox's container, keep its
 * disk. /home/user survives; everything else resets onto the current image
 * of the sandbox's template (or the base image) at the next use.
 */
export async function sandboxRebuild(
  client: Dormice,
  name: string,
): Promise<string> {
  const { sandbox } = await client.rebuildSandbox(name);
  const target = sandbox.template
    ? `template "${printable(sandbox.template)}"'s current image`
    : 'the current base image';
  return (
    `Rebuilt the sandbox "${printable(name)}" — /home/user kept, ` +
    `now ${sandbox.state}; its next use starts on ${target}.`
  );
}

/** `dor sandbox destroy <name>`: destroy the sandbox behind a key, idempotently. */
export async function sandboxDestroy(
  client: Dormice,
  name: string,
): Promise<string> {
  const { destroyed } = await client.destroySandbox(name);
  return destroyed
    ? `Destroyed the sandbox "${printable(name)}".`
    : `No sandbox named "${printable(name)}" — nothing to destroy.`;
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
    // Moves only on a real image change; equal to CREATED = never upgraded.
    { header: 'UPDATED', value: (t) => t.updatedAt },
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

/**
 * The CLI speaks names; the wire speaks ids (names are renameable, so the
 * id is the stable address). One resolver, used by every verb that edits a
 * key. "Not revoked" is the filter, deliberately wider than "live":
 * disabled and expired keys still hold their name, and the operator must
 * be able to enable or revoke them by it.
 */
async function resolveApiKeyId(
  client: Dormice,
  name: string,
): Promise<string | null> {
  const keys = await client.listApiKeys();
  return keys.find((k) => k.name === name && k.revokedAt === null)?.id ?? null;
}

/**
 * Strictly YYYY-MM-DD, expiring at the END of that local day — "expires
 * 2026-08-01" naturally reads as "works through August 1st", and the
 * console's date picker uses the same semantics.
 */
function parseExpiresDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(
      `--expires must be a date like 2026-12-31 (got "${printable(value)}")`,
    );
  }
  const [, year, month, day] = match;
  const endOfDay = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    23,
    59,
    59,
    999,
  );
  // The Date constructor rolls impossible dates over (Feb 31 -> Mar 3)
  // instead of failing; a round-trip check keeps the refusal honest.
  if (
    endOfDay.getFullYear() !== Number(year) ||
    endOfDay.getMonth() !== Number(month) - 1 ||
    endOfDay.getDate() !== Number(day)
  ) {
    throw new Error(`--expires: "${printable(value)}" is not a real date`);
  }
  return endOfDay.toISOString();
}

/**
 * `dor apikey create <name> [--expires YYYY-MM-DD]`: mint an API key. The
 * token line is the one and only time the key material exists outside the
 * daemon's hash — the warning is part of the output, not decoration.
 */
export async function apikeyCreate(
  client: Dormice,
  name: string,
  expires?: string,
): Promise<string> {
  const expiresAt =
    expires === undefined ? undefined : parseExpiresDate(expires);
  const { apiKey, token } = await client.createApiKey(
    name,
    expiresAt ? { expiresAt } : undefined,
  );
  return (
    `Created API key "${printable(apiKey.name)}" (prefix ${apiKey.prefix}` +
    (apiKey.expiresAt ? `, expires ${apiKey.expiresAt}` : '') +
    ').\n' +
    `${token}\n` +
    'Store it now — it will never be shown again.'
  );
}

/** `dor apikey ls`: every key ever minted, revoked ones included, as plain columns. */
export async function apikeyLs(client: Dormice): Promise<string> {
  const keys = await client.listApiKeys();
  if (keys.length === 0) {
    return 'No API keys.';
  }
  const now = Date.now();
  const columns: { header: string; value: (k: ApiKey) => string }[] = [
    { header: 'NAME', value: (k) => k.name },
    { header: 'PREFIX', value: (k) => k.prefix },
    { header: 'CREATED', value: (k) => k.createdAt },
    { header: 'LAST USED', value: (k) => k.lastUsedAt ?? 'never' },
    { header: 'EXPIRES', value: (k) => k.expiresAt ?? 'never' },
    { header: 'STATUS', value: (k) => apiKeyStatus(k, now) },
  ];
  return renderTable(
    columns.map((column) => column.header),
    keys.map((k) => columns.map((column) => printable(column.value(k)))),
  );
}

/**
 * `dor apikey revoke <name>`: kill the non-revoked key under a name. The
 * false branch is said out loud — a silent miss here would leave a leaked
 * key alive behind a typo.
 */
export async function apikeyRevoke(
  client: Dormice,
  name: string,
): Promise<string> {
  const id = await resolveApiKeyId(client, name);
  const revoked = id === null ? false : (await client.revokeApiKey(id)).revoked;
  return revoked
    ? `Revoked API key "${printable(name)}" — it stops working immediately.`
    : `No active API key named "${printable(name)}" — nothing to revoke.`;
}

/**
 * `dor apikey disable <name>`: park a key reversibly — it stops working on
 * the next request but keeps its name and history, unlike revoke.
 */
export async function apikeyDisable(
  client: Dormice,
  name: string,
): Promise<string> {
  const id = await resolveApiKeyId(client, name);
  if (id === null) {
    throw new Error(`no API key named "${printable(name)}"`);
  }
  await client.updateApiKey(id, { disabled: true });
  return `Disabled API key "${printable(name)}" — it stops working until re-enabled.`;
}

/** `dor apikey enable <name>`: resume a parked key. */
export async function apikeyEnable(
  client: Dormice,
  name: string,
): Promise<string> {
  const id = await resolveApiKeyId(client, name);
  if (id === null) {
    throw new Error(`no API key named "${printable(name)}"`);
  }
  await client.updateApiKey(id, { disabled: false });
  return `Enabled API key "${printable(name)}".`;
}
