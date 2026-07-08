import {
  type AcquireResponse,
  acquireResponseSchema,
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

  /** Native API convention: every operation is POST /<method>, body in, body out. */
  private async rpc(method: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.endpoint}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      // Rejects with a TimeoutError — honestly not an API error, so it is
      // deliberately not wrapped in DormiceApiError.
      signal: AbortSignal.timeout(this.timeoutMs),
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
