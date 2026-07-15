import type {
  AcquireRequest,
  AcquireResponse,
  ApplyUpgradeResponse,
  CheckUpgradeResponse,
  GetConfigResponse,
  GetFleetTimelineResponse,
  GetIngressResponse,
  GetSandboxMetricsHistoryResponse,
  GetSandboxMetricsResponse,
  GetUpgradeStatusResponse,
  HostMetricsResponse,
  LifecyclePolicyOverride,
  ListActivityResponse,
  ListSandboxImagesResponse,
  ListSandboxMetricsResponse,
  RegisterTemplateResponse,
  Sandbox,
  SetIngressResponse,
  Template,
} from '@dormice/shared';
import { clearSessionMarker, hasSessionMarker } from './session';

/**
 * The console talks to the daemon's native RPC routes — the same routes,
 * same truth as the SDK and CLI — authenticated by the httpOnly session
 * cookie the browser attaches on its own. The custom header is the second
 * half of the CSRF defense: a cross-origin page cannot send it without a
 * CORS preflight, and the daemon answers no preflights.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Session-expiry backstop, in one place instead of per page: any business
 * call answered 401 while we believed we were signed in means the cookie
 * died (expired, or the API token was rotated). Clear the stale marker and
 * do a full-page jump to the login route — a reload guarantees no leftover
 * query cache or component state survives, and the redirect param brings
 * the operator back to where they were.
 */
function interceptUnauthorized(): void {
  if (!hasSessionMarker()) return;
  clearSessionMarker();
  const here = window.location.pathname + window.location.search;
  window.location.href = `/console/login?redirect=${encodeURIComponent(here)}`;
}

async function rpc<T>(
  path: string,
  body: unknown = {},
  { intercept401 = true } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dormice-console': '1',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && intercept401) {
    interceptUnauthorized();
  }
  if (!res.ok) {
    const message = await res
      .json()
      .then((data: { message?: string }) => data.message)
      .catch(() => undefined);
    throw new ApiError(
      message ?? `${path} failed with ${res.status}`,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

// Whether setup has happened — the login page's fork: no account yet means
// it renders the initialization form instead of username/password.
export const authStatus = () =>
  rpc<{ accountExists: boolean }>(
    '/console/auth/status',
    {},
    { intercept401: false },
  );

// First-run initialization, password change and forgot-password are all this
// one verb: the API token is the root of trust, presenting it (re)writes the
// single account and signs the caller in.
export const setup = (input: {
  token: string;
  username: string;
  password: string;
}) =>
  rpc<{ loggedIn: true }>('/console/auth/setup', input, {
    intercept401: false,
  });

// Login's own 401 means "wrong credentials", a form error to show in place —
// the interceptor is for sessions dying mid-flight, not for failed sign-ins.
export const login = (input: { username: string; password: string }) =>
  rpc<{ loggedIn: true }>('/console/auth/login', input, {
    intercept401: false,
  });

export const logout = () =>
  rpc<{ loggedIn: false }>('/console/auth/logout', {}, { intercept401: false });

export const listSandboxes = () =>
  rpc<{ sandboxes: Sandbox[] }>('/listSandboxes');

// The host-level observation window: machine health plus fleet aggregates.
// Pure observation — the daemon wakes nothing to answer it.
export const getHostMetrics = () => rpc<HostMetricsResponse>('/getHostMetrics');

// One sandbox's point-in-time reading. Same principle: a frozen sandbox is
// measured as it sleeps, a stopped one answers sample: null — never woken.
export const getSandboxMetrics = (externalId: string) =>
  rpc<GetSandboxMetricsResponse>('/getSandboxMetrics', { externalId });

// Every measurable sandbox in one answer — the list view's food. Presence
// means measured: colder states are simply absent.
export const listSandboxMetrics = () =>
  rpc<ListSandboxMetricsResponse>('/listSandboxMetrics');

// One sandbox's sampled past, sliced by an ISO window. Past 360 points the
// daemon buckets the answer (per-field maxima — spikes survive); a window
// the daemon was down for shows the gap, never an interpolation.
export const getSandboxMetricsHistory = (
  externalId: string,
  start: string,
  end: string,
) =>
  rpc<GetSandboxMetricsHistoryResponse>('/getSandboxMetricsHistory', {
    externalId,
    start,
    end,
  });

// Fleet state counts over time — the concurrency curve's data. Bucketed
// points are whole raw snapshots (byState always sums to total); peak is
// computed from raw rows and immune to bucketing.
export const getFleetTimeline = (start: string, end: string) =>
  rpc<GetFleetTimelineResponse>('/getFleetTimeline', { start, end });

// Every sandbox's image lineage: the born image of the current shell (null
// when no shell exists), the image the next shell would boot, and whether a
// rebuild would change anything — the window answering "who still runs an
// old image?" after a template upgrade.
export const listSandboxImages = () =>
  rpc<ListSandboxImagesResponse>('/listSandboxImages');

// The ledger's recent history, newest first — a bounded ring, not an audit
// log. The daemon records at the moves themselves; this only reads.
export const listActivity = (limit?: number) =>
  rpc<ListActivityResponse>('/listActivity', limit ? { limit } : {});

// Effective configuration, read-only. Secrets come back as "set", never as
// their value; archive.enabled is the daemon's own adjudication.
export const getConfig = () => rpc<GetConfigResponse>('/getConfig');

// Is a newer Dormice available? The daemon compares its built commit
// against the origin's main and caches the answer for an hour; force is
// the "check now" button. A failed check is data (checkError), not a 500.
export const checkUpgrade = (force = false) =>
  rpc<CheckUpgradeResponse>('/checkUpgrade', { force });

// The one-click upgrade: the daemon hands install.sh to a systemd unit
// that outlives its own restart, then answers { started: true }. Progress
// lives in getUpgradeStatus; expect the daemon to restart near the end.
export const applyUpgrade = () =>
  rpc<ApplyUpgradeResponse>('/applyUpgrade', {});

// The upgrade execution window: availability, unit liveness (from systemd,
// not the status file's claim), the last run's report and the log tail.
export const getUpgradeStatus = () =>
  rpc<GetUpgradeStatusResponse>('/getUpgradeStatus', {});

// The daemon's front door: whether it manages a reverse proxy config, and
// every bound domain with live probes (DNS record, certificate served).
export const getIngress = () => rpc<GetIngressResponse>('/getIngress');

// Set the full console domain list (set semantics: send the list you want,
// empty clears everything). Returns once the proxy accepted the config; the
// certificates converge afterwards — poll getIngress and show the honest
// probes.
export const setIngress = (domains: string[]) =>
  rpc<SetIngressResponse>('/setIngress', { domains });

export const listTemplates = () =>
  rpc<{ templates: Template[] }>('/listTemplates');

// An upsert: re-registering a name points it at a new image — that IS the
// template upgrade front door (then rebuild the sandboxes that should move).
export const registerTemplate = (name: string, image: string) =>
  rpc<RegisterTemplateResponse>('/registerTemplate', { name, image });

// Refused with 409 while sandboxes still use the template — the daemon is
// the arbiter and its message names the keys; the console just relays it.
export const removeTemplate = (name: string) =>
  rpc<{ removed: boolean }>('/removeTemplate', { name });

export const acquireSandbox = (request: AcquireRequest) =>
  rpc<AcquireResponse>('/acquireSandbox', request);

export const destroySandbox = (externalId: string) =>
  rpc<{ destroyed: boolean }>('/destroySandbox', { externalId });

// Swap the container, keep /home/user: the next use starts on the daemon's
// current base image.
export const rebuildSandbox = (externalId: string) =>
  rpc<{ sandbox: Sandbox }>('/rebuildSandbox', { externalId });

// Patch the stored lifecycle policy in place — the update verb acquire is
// not. Ledger-only: nothing wakes, the idle clock keeps running.
export const updatePolicy = (
  externalId: string,
  policy: LifecyclePolicyOverride,
) => rpc<{ sandbox: Sandbox }>('/updatePolicy', { externalId, policy });

// The terminal's key: trades the session cookie for one sandbox's envd
// access token, so the browser can speak to the envd surface directly.
export const mintEnvdToken = (sandboxId: string) =>
  rpc<{ envdAccessToken: string }>('/console/envdToken', { sandboxId });
