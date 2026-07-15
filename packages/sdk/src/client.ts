import {
  type AcquireResponse,
  type ActivityEvent,
  type ApiKey,
  type ApplyUpgradeResponse,
  acquireResponseSchema,
  applyUpgradeResponseSchema,
  type CheckUpgradeResponse,
  type CreateApiKeyResponse,
  checkUpgradeResponseSchema,
  createApiKeyResponseSchema,
  DEFAULT_EXEC_TIMEOUT_SECONDS,
  type DestroySandboxResponse,
  destroySandboxResponseSchema,
  type ExecCommandResponse,
  execCommandResponseSchema,
  type GetConfigResponse,
  type GetFleetTimelineResponse,
  type GetIngressResponse,
  type GetSandboxMetricsHistoryResponse,
  type GetUpgradeStatusResponse,
  getConfigResponseSchema,
  getFleetTimelineResponseSchema,
  getIngressResponseSchema,
  getSandboxMetricsHistoryResponseSchema,
  getSandboxMetricsResponseSchema,
  getUpgradeStatusResponseSchema,
  type HostMetricsResponse,
  hostMetricsResponseSchema,
  type LifecyclePolicyOverride,
  type ListSandboxImagesResponse,
  type ListSandboxMetricsResponse,
  listActivityResponseSchema,
  listApiKeysResponseSchema,
  listSandboxesResponseSchema,
  listSandboxImagesResponseSchema,
  listSandboxMetricsResponseSchema,
  listTemplatesResponseSchema,
  type RebuildSandboxResponse,
  type RegisterTemplateResponse,
  type RemoveTemplateResponse,
  type RevokeApiKeyResponse,
  readFileResponseSchema,
  readFilesResponseSchema,
  rebuildSandboxResponseSchema,
  registerTemplateResponseSchema,
  removeTemplateResponseSchema,
  revokeApiKeyResponseSchema,
  type Sandbox,
  type SandboxMetadata,
  type SandboxMetricsSample,
  type SetIngressResponse,
  setIngressResponseSchema,
  type Template,
  type UpdateMetadataResponse,
  type UpdatePolicyResponse,
  updateMetadataResponseSchema,
  updatePolicyResponseSchema,
  type WriteFileResponse,
  type WriteFilesResponse,
  writeFileResponseSchema,
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
  /**
   * Labels stored when this acquire creates the sandbox. Same rules as
   * policy: creation-time only — relabel an existing sandbox through
   * updateMetadata.
   */
  metadata?: SandboxMetadata;
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
   * acquire(externalId): the platform's single entry point, idempotent — the
   * same key always comes back to the same sandbox, whatever state it was
   * in. A `restoring` status means the sandbox is being pulled back from
   * the archive; poll until it flips to `ready`.
   */
  async acquireSandbox(
    externalId: string,
    options?: AcquireSandboxOptions,
  ): Promise<AcquireResponse> {
    const data = await this.rpc('acquireSandbox', {
      externalId,
      policy: options?.policy,
      template: options?.template,
      metadata: options?.metadata,
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
   * The daemon host's own health in one snapshot: CPU, memory and swap
   * (the freeze mechanism's fuel), the data disk, ledger aggregates, and
   * what the sparse sandbox disks nominally promise versus actually occupy.
   * Pure observation — never wakes a sandbox. Readings the platform cannot
   * produce come back null, never invented.
   */
  async getHostMetrics(): Promise<HostMetricsResponse> {
    const data = await this.rpc('getHostMetrics', {});
    return hostMetricsResponseSchema.parse(data);
  }

  /**
   * One sandbox's point-in-time resource reading (CPU, memory, disk).
   * Observation never wakes: a frozen sandbox is measured as it sleeps,
   * and with no running container (stopped, archived, restoring) the
   * sample is null. For the past, see getSandboxMetricsHistory.
   */
  async getSandboxMetrics(
    externalId: string,
  ): Promise<SandboxMetricsSample | null> {
    const data = await this.rpc('getSandboxMetrics', { externalId });
    return getSandboxMetricsResponseSchema.parse(data).sample;
  }

  /**
   * One sandbox's sampled history, sliced by an optional ISO window
   * (default: the last hour). Past 360 points the server buckets the
   * answer — `bucketSeconds` says how wide — and each bucket reports its
   * per-field maxima, so spikes survive. An unsampled window answers an
   * empty array, never an invented reading; a window the daemon was down
   * for shows the gap.
   */
  async getSandboxMetricsHistory(
    externalId: string,
    options?: { start?: string; end?: string },
  ): Promise<GetSandboxMetricsHistoryResponse> {
    const data = await this.rpc('getSandboxMetricsHistory', {
      externalId,
      start: options?.start,
      end: options?.end,
    });
    return getSandboxMetricsHistoryResponseSchema.parse(data);
  }

  /**
   * Fleet state counts over time (default window: the last 24 hours) —
   * how many sandboxes sat active/frozen/stopped/archived/restoring at
   * each sampler tick. Bucketed points are whole raw snapshots (byState
   * always sums to total); `peak` carries the window's highest active
   * count from raw rows, immune to bucketing.
   */
  async getFleetTimeline(options?: {
    start?: string;
    end?: string;
  }): Promise<GetFleetTimelineResponse> {
    const data = await this.rpc('getFleetTimeline', {
      start: options?.start,
      end: options?.end,
    });
    return getFleetTimelineResponseSchema.parse(data);
  }

  /**
   * Every measurable sandbox's reading in one answer — a view over N
   * sandboxes costs one request instead of N. Presence means measured:
   * only physically running/paused sandboxes appear; colder states are
   * absent (getSandboxMetrics's null, expressed as absence).
   */
  async listSandboxMetrics(): Promise<ListSandboxMetricsResponse['samples']> {
    const data = await this.rpc('listSandboxMetrics', {});
    return listSandboxMetricsResponseSchema.parse(data).samples;
  }

  /**
   * Every sandbox's image lineage in one answer: the image its current
   * shell was born from (`image`, null when no shell exists), the image
   * its next shell would boot (`nextImage`), and whether a rebuild would
   * change anything (`upgradable`). The window answering "which sandboxes
   * still run an old image?" after a template is re-registered.
   */
  async listSandboxImages(): Promise<ListSandboxImagesResponse['images']> {
    const data = await this.rpc('listSandboxImages', {});
    return listSandboxImagesResponseSchema.parse(data).images;
  }

  /**
   * The daemon's recent history, newest first: who was created, cooled,
   * woken, destroyed, and what reconciliation repaired. A bounded ring —
   * an explanation window, not an audit log.
   */
  async listActivity(options?: { limit?: number }): Promise<ActivityEvent[]> {
    const data = await this.rpc('listActivity', {
      limit: options?.limit,
    });
    return listActivityResponseSchema.parse(data).events;
  }

  /**
   * The daemon's effective configuration, read-only: every knob, the value
   * in force, and whether it came from the environment or a default.
   * Secrets are reported as present-or-absent only. `archive.enabled` is
   * the daemon's own adjudication of whether archiving is available.
   */
  async getConfig(): Promise<GetConfigResponse> {
    const data = await this.rpc('getConfig', {});
    return getConfigResponseSchema.parse(data);
  }

  /**
   * Is a newer Dormice available for this daemon? Versions are git
   * commits (trunk-based, no tags yet): the commit baked into the running
   * build is compared against the origin's main, fetched through the
   * checkout's own remote. The answer is served from a short-lived
   * server-side cache; `force: true` is the "check now" button. A failed
   * check comes back as `checkError` with `check: null` — never invented
   * freshness.
   */
  async checkUpgrade(options?: {
    force?: boolean;
  }): Promise<CheckUpgradeResponse> {
    const data = await this.rpc('checkUpgrade', {
      force: options?.force,
    });
    return checkUpgradeResponseSchema.parse(data);
  }

  /**
   * The one-click upgrade: the daemon launches install.sh (re-running it
   * IS the upgrade) in a systemd transient unit that outlives the daemon's
   * own restart. Returns as soon as the unit started — watch it land with
   * getUpgradeStatus. 400 when one-click is unavailable (fake executor, no
   * git checkout, no systemd); 409 when an upgrade is already running.
   * Expect the daemon to restart near the end: in-flight execs, terminals
   * and watchers break, sandboxes and their disks are untouched.
   */
  async applyUpgrade(): Promise<ApplyUpgradeResponse> {
    const data = await this.rpc('applyUpgrade', {});
    return applyUpgradeResponseSchema.parse(data);
  }

  /**
   * The upgrade execution window: whether one-click is available at all,
   * whether the systemd unit is alive right now, the last run's report
   * (state, commits, error) as install.sh wrote it, and the log tail. A
   * run that died without reporting comes back as an honest failure.
   */
  async getUpgradeStatus(): Promise<GetUpgradeStatusResponse> {
    const data = await this.rpc('getUpgradeStatus', {});
    return getUpgradeStatusResponseSchema.parse(data);
  }

  /**
   * The daemon's managed front door (the reverse proxy in front of it):
   * whether one is managed at all, and every bound domain with live probes
   * — what each domain resolves to and whether the proxy serves a valid
   * certificate for it. Probes are measured at request time, never cached.
   */
  async getIngress(): Promise<GetIngressResponse> {
    const data = await this.rpc('getIngress', {});
    return getIngressResponseSchema.parse(data);
  }

  /**
   * Sets the full domain list on the daemon's front door (set semantics:
   * send the list you want, empty unbinds everything): the managed Caddy
   * config is rewritten and reloaded, and Caddy obtains each TLS
   * certificate on its own. Returns as soon as the proxy accepted the
   * config — poll getIngress to watch DNS and the certificates converge.
   * Refused (400) when the daemon manages no proxy.
   */
  async setIngress(domains: string[]): Promise<SetIngressResponse> {
    const data = await this.rpc('setIngress', { domains });
    return setIngressResponseSchema.parse(data);
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
  async rebuildSandbox(externalId: string): Promise<RebuildSandboxResponse> {
    const data = await this.rpc('rebuildSandbox', { externalId });
    return rebuildSandboxResponseSchema.parse(data);
  }

  /**
   * Updates the sandbox's lifecycle policy in place — the update verb
   * acquire deliberately is not. Patch semantics over the stored policy:
   * omitted fields keep their current values, `null` means "never take
   * that step" (e.g. `{stopAfterSeconds: null}` promotes a sandbox to a
   * never-stop resident agent). A pure ledger write: nothing is woken, and
   * the idle clock is not refreshed. Unknown key: 404 — not a creator.
   */
  async updatePolicy(
    externalId: string,
    policy: LifecyclePolicyOverride,
  ): Promise<UpdatePolicyResponse> {
    const data = await this.rpc('updatePolicy', { externalId, policy });
    return updatePolicyResponseSchema.parse(data);
  }

  /**
   * Replaces the sandbox's label set in place — full replacement, `{}`
   * clears every label. A pure ledger write: nothing is woken, and the
   * idle clock is not refreshed. Unknown key: 404 — not a creator.
   */
  async updateMetadata(
    externalId: string,
    metadata: SandboxMetadata,
  ): Promise<UpdateMetadataResponse> {
    const data = await this.rpc('updateMetadata', { externalId, metadata });
    return updateMetadataResponseSchema.parse(data);
  }

  /**
   * Destroys the sandbox behind an external id — container and disk are gone
   * for good. Idempotent like acquire: a key that has no sandbox is not an
   * error, the response just says `destroyed: false`.
   */
  async destroySandbox(externalId: string): Promise<DestroySandboxResponse> {
    const data = await this.rpc('destroySandbox', { externalId });
    return destroySandboxResponseSchema.parse(data);
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
   * Mints an API key — a full-power peer of the daemon's env token that can
   * be revoked without touching the server. The returned `token` (64 hex
   * chars) is shown here EXACTLY ONCE: the daemon stores only its hash, so
   * no later call can retrieve it. Refused with a 409 while an active key
   * already answers to this name.
   */
  async createApiKey(name: string): Promise<CreateApiKeyResponse> {
    const data = await this.rpc('createApiKey', { name });
    return createApiKeyResponseSchema.parse(data);
  }

  /** Every key ever minted, revoked ones included, newest first. No secrets. */
  async listApiKeys(): Promise<ApiKey[]> {
    const data = await this.rpc('listApiKeys', {});
    return listApiKeysResponseSchema.parse(data).apiKeys;
  }

  /**
   * Revokes the active key under a name — the credential stops working on
   * the very next request; the row stays listed as rotation history.
   * Idempotent: an unknown or already-revoked name answers `revoked: false`.
   */
  async revokeApiKey(name: string): Promise<RevokeApiKeyResponse> {
    const data = await this.rpc('revokeApiKey', { name });
    return revokeApiKeyResponseSchema.parse(data);
  }

  /**
   * Runs a shell command inside the sandbox behind an external id and returns
   * the buffered result: honest exit code (a nonzero exit is a result, not
   * an error), stdout/stderr capped at 1 MiB per stream. Wakes a cold
   * sandbox first, and counts as activity for the whole run — the idle
   * scanner never freezes a sandbox mid-command.
   */
  async execCommand(
    externalId: string,
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
        externalId,
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
   * Writes a batch of files into the sandbox behind an external id, waking a
   * cold sandbox first. Parents are created, existing files overwritten.
   * Per-file cap is 16 MiB — content travels as base64 inside JSON; a big
   * batch on a slow link may need a larger client `timeoutMs`.
   */
  async writeFiles(
    externalId: string,
    files: FileToWrite[],
  ): Promise<WriteFilesResponse> {
    const data = await this.rpc('writeFiles', {
      externalId,
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
   * Writes one file into the sandbox — the single-file form of writeFiles,
   * same rules (parents created, existing file overwritten, 16 MiB cap).
   */
  async writeFile(
    externalId: string,
    path: string,
    content: string | Uint8Array,
  ): Promise<WriteFileResponse> {
    const data = await this.rpc('writeFile', {
      externalId,
      path,
      contentBase64: Buffer.from(
        typeof content === 'string'
          ? new TextEncoder().encode(content)
          : content,
      ).toString('base64'),
    });
    return writeFileResponseSchema.parse(data);
  }

  /**
   * Reads one file's bytes out of the sandbox. A file over the 16 MiB cap
   * is refused by the daemon (413), never truncated.
   */
  async readFile(externalId: string, path: string): Promise<ReadFileResult> {
    const data = await this.rpc('readFile', { externalId, path });
    const parsed = readFileResponseSchema.parse(data);
    return {
      path: parsed.path,
      content: new Uint8Array(Buffer.from(parsed.contentBase64, 'base64')),
    };
  }

  /**
   * Reads a batch of files, all or nothing: one missing path fails the
   * whole call (404 naming it) — a caller that can tolerate absence asks
   * file by file. Files come back in request order; the batch total is
   * capped at 48 MiB by the daemon (413).
   */
  async readFiles(
    externalId: string,
    paths: string[],
  ): Promise<ReadFileResult[]> {
    const data = await this.rpc('readFiles', { externalId, paths });
    return readFilesResponseSchema.parse(data).files.map((file) => ({
      path: file.path,
      content: new Uint8Array(Buffer.from(file.contentBase64, 'base64')),
    }));
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
