import {
  type AcquireResponse,
  acquireResponseSchema,
  DEFAULT_EXEC_TIMEOUT_SECONDS,
  type ExecCommandResponse,
  execCommandResponseSchema,
  type LifecyclePolicyOverride,
  listSandboxesResponseSchema,
  type ReleaseSandboxResponse,
  releaseSandboxResponseSchema,
  type Sandbox,
} from '@dormice/shared';

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

export interface ExecCommandOptions {
  /** In-container deadline; on expiry the command is SIGKILLed (exit 137). */
  timeoutSeconds?: number;
  /** Working directory inside the sandbox; defaults to /home/user. */
  cwd?: string;
  env?: Record<string, string>;
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
    policy?: LifecyclePolicyOverride,
  ): Promise<AcquireResponse> {
    const data = await this.rpc('acquireSandbox', { userKey, policy });
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
   * Destroys the sandbox behind a user key — container and disk are gone
   * for good. Idempotent like acquire: a key that has no sandbox is not an
   * error, the response just says `released: false`.
   */
  async releaseSandbox(userKey: string): Promise<ReleaseSandboxResponse> {
    const data = await this.rpc('releaseSandbox', { userKey });
    return releaseSandboxResponseSchema.parse(data);
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
