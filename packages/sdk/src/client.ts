import {
  type AcquireResponse,
  acquireResponseSchema,
  DEFAULT_EXEC_TIMEOUT_SECONDS,
  type ExecCommandResponse,
  execCommandResponseSchema,
  type LifecyclePolicyOverride,
  listSandboxesResponseSchema,
  listTemplatesResponseSchema,
  type RebuildSandboxResponse,
  type RegisterTemplateResponse,
  type ReleaseSandboxResponse,
  type RemoveTemplateResponse,
  readFileResponseSchema,
  rebuildSandboxResponseSchema,
  registerTemplateResponseSchema,
  releaseSandboxResponseSchema,
  removeTemplateResponseSchema,
  type Sandbox,
  type Template,
  type WriteFilesResponse,
  writeFilesResponseSchema,
} from '@dormice/shared';
import { Agent, fetch, type Response } from 'undici';

// The daemon answers an exec only when the command finishes, so response
// headers can be legitimately hours away — but a default dispatcher stops
// waiting for headers after 300s (measured 2026-07-09: every exec past five
// minutes died as `fetch failed`). This dispatcher switches undici's hidden
// clocks off; the AbortSignal in rpc() is the one deadline that counts.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export interface DormiceOptions {
  /** Base URL of the daemon, e.g. `http://127.0.0.1:3676`. */
  endpoint: string;
  /** The daemon's DORMICE_API_TOKEN. */
  token: string;
  /**
   * Per-request timeout. Without one, a wedged daemon would hang the
   * caller forever. 30s covers the slowest honest answer (waking a stopped
   * sandbox takes seconds; restores return `restoring` immediately).
   */
  timeoutMs?: number;
}

export interface FileToWrite {
  /** Absolute, or relative to /home/user. */
  path: string;
  /** A string is written as its UTF-8 bytes; a Uint8Array is written as-is. */
  content: string | Uint8Array;
}

export interface ReadFileResult {
  /** The path as resolved inside the sandbox, always absolute. */
  path: string;
  /** The file's exact bytes. Text? `new TextDecoder().decode(content)`. */
  content: Uint8Array;
}

export interface ExecCommandOptions {
  /** In-container deadline; on expiry the command is SIGKILLed (exit 137). */
  timeoutSeconds?: number;
  /** Working directory inside the sandbox; defaults to /home/user. */
  cwd?: string;
  env?: Record<string, string>;
}

export interface AcquireSandboxOptions {
  /**
   * Lifecycle override applied when this acquire creates the sandbox;
   * an existing sandbox keeps its stored policy, but an invalid override
   * is still a 400.
   */
  policy?: LifecyclePolicyOverride;
  /**
   * Registered template to create the sandbox from; omitted means the
   * daemon's base image. Same rules as policy: creation-time only, and an
   * unknown name is a 400.
   */
  template?: string;
}

/** A non-2xx answer from the daemon, carrying the HTTP status and the server's message. */
export class DormiceApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DormiceApiError';
    this.status = status;
  }
}

export class Dormice {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: DormiceOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * acquire(userKey): the platform's single entry point, idempotent — the
   * same key always comes back to the same sandbox, whatever state it was
   * in. A `restoring` status means the sandbox is being pulled back from
   * the archive; poll until it flips to `ready`.
   */
  async acquireSandbox(
    userKey: string,
    options?: AcquireSandboxOptions,
  ): Promise<AcquireResponse> {
    const data = await this.rpc('acquireSandbox', {
      userKey,
      policy: options?.policy,
      template: options?.template,
    });
    // Never trust the wire blindly: parsing against the shared schema makes
    // a version-skewed or misbehaving server fail loudly right here.
    return acquireResponseSchema.parse(data);
  }

  /** Every sandbox on the daemon with its current lifecycle state. */
  async listSandboxes(): Promise<Sandbox[]> {
    const data = await this.rpc('listSandboxes', {});
    return listSandboxesResponseSchema.parse(data).sandboxes;
  }

  /**
   * Swaps the sandbox's container while keeping its disk: /home/user is
   * untouched, and the next use builds a fresh container from the current
   * image of the sandbox's template (or the daemon's current base image) —
   * how an existing sandbox picks up new shared layers (anything outside
   * /home/user is reset). The sandbox is left `stopped`; the next acquire
   * or exec wakes it, paying one cold start. Unknown key: 404 — rebuild is
   * not a creator.
   */
  async rebuildSandbox(userKey: string): Promise<RebuildSandboxResponse> {
    const data = await this.rpc('rebuildSandbox', { userKey });
    return rebuildSandboxResponseSchema.parse(data);
  }

  /**
   * Destroys the sandbox behind a user key — container and disk are gone
   * for good. Idempotent like acquire: a key that has no sandbox is not an
   * error, the response just says `released: false`.
   */
  async releaseSandbox(userKey: string): Promise<ReleaseSandboxResponse> {
    const data = await this.rpc('releaseSandbox', { userKey });
    return releaseSandboxResponseSchema.parse(data);
  }

  /**
   * Names a Docker image on the daemon's host as a template. An upsert:
   * re-registering a name re-points it at the new image — how a template is
   * upgraded (existing sandboxes move on their next rebuildSandbox). The
   * image is not checked for existence; it may arrive after registration.
   */
  async registerTemplate(
    name: string,
    image: string,
  ): Promise<RegisterTemplateResponse> {
    const data = await this.rpc('registerTemplate', { name, image });
    return registerTemplateResponseSchema.parse(data);
  }

  /** Every registered template. */
  async listTemplates(): Promise<Template[]> {
    const data = await this.rpc('listTemplates', {});
    return listTemplatesResponseSchema.parse(data).templates;
  }

  /**
   * Removes a template's registration (never the image). Refused with a 409
   * while any sandbox still uses it; idempotent on an unknown name.
   */
  async removeTemplate(name: string): Promise<RemoveTemplateResponse> {
    const data = await this.rpc('removeTemplate', { name });
    return removeTemplateResponseSchema.parse(data);
  }

  /**
   * Runs a shell command inside the sandbox behind a user key and returns
   * the buffered result: honest exit code (a nonzero exit is a result, not
   * an error), stdout/stderr capped at 1 MiB per stream. Wakes a cold
   * sandbox first, and counts as activity for the whole run — the idle
   * scanner never freezes a sandbox mid-command.
   */
  async execCommand(
    userKey: string,
    command: string,
    options?: ExecCommandOptions,
  ): Promise<ExecCommandResponse> {
    // Resolved client-side so the HTTP deadline below is always derived
    // from the same number the container enforces — the shared default,
    // not the client-wide timeoutMs, which would cut a long command short.
    const timeoutSeconds =
      options?.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS;
    const data = await this.rpc(
      'execCommand',
      {
        userKey,
        command,
        timeoutSeconds,
        cwd: options?.cwd,
        env: options?.env,
      },
      // Slack on top covers the wake (seconds) and the round-trip.
      timeoutSeconds * 1000 + 30_000,
    );
    return execCommandResponseSchema.parse(data);
  }

  /**
   * Writes a batch of files into the sandbox behind a user key, waking a
   * cold sandbox first. Parents are created, existing files overwritten.
   * Per-file cap is 16 MiB — content travels as base64 inside JSON; a big
   * batch on a slow link may need a larger client `timeoutMs`.
   */
  async writeFiles(
    userKey: string,
    files: FileToWrite[],
  ): Promise<WriteFilesResponse> {
    const data = await this.rpc('writeFiles', {
      userKey,
      files: files.map((file) => ({
        path: file.path,
        contentBase64: Buffer.from(
          typeof file.content === 'string'
            ? new TextEncoder().encode(file.content)
            : file.content,
        ).toString('base64'),
      })),
    });
    return writeFilesResponseSchema.parse(data);
  }

  /**
   * Reads one file's bytes out of the sandbox. A file over the 16 MiB cap
   * is refused by the daemon (413), never truncated.
   */
  async readFile(userKey: string, path: string): Promise<ReadFileResult> {
    const data = await this.rpc('readFile', { userKey, path });
    const parsed = readFileResponseSchema.parse(data);
    return {
      path: parsed.path,
      content: new Uint8Array(Buffer.from(parsed.contentBase64, 'base64')),
    };
  }

  /** Native API convention: every operation is POST /<method>, body in, body out. */
  private async rpc(
    method: string,
    body: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    const response = await fetch(`${this.endpoint}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      dispatcher,
      // Rejects with a TimeoutError — honestly not an API error, so it is
      // deliberately not wrapped in DormiceApiError.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new DormiceApiError(response.status, await errorMessage(response));
    }
    return response.json();
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string };
    if (typeof data.message === 'string') {
      return data.message;
    }
  } catch {
    // Non-JSON error body; fall through to the status line.
  }
  return `${response.status} ${response.statusText}`;
}
