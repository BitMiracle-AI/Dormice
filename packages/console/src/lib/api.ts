import type {
  AcquireRequest,
  AcquireResponse,
  HostMetricsResponse,
  Sandbox,
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

// Login's own 401 means "wrong token", a form error to show in place — the
// interceptor is for sessions dying mid-flight, not for failed sign-ins.
export const login = (token: string) =>
  rpc<{ loggedIn: true }>(
    '/console/auth/login',
    { token },
    { intercept401: false },
  );

export const logout = () =>
  rpc<{ loggedIn: false }>('/console/auth/logout', {}, { intercept401: false });

export const listSandboxes = () =>
  rpc<{ sandboxes: Sandbox[] }>('/listSandboxes');

// The host-level observation window: machine health plus fleet aggregates.
// Pure observation — the daemon wakes nothing to answer it.
export const getHostMetrics = () => rpc<HostMetricsResponse>('/getHostMetrics');

export const listTemplates = () =>
  rpc<{ templates: Template[] }>('/listTemplates');

export const acquireSandbox = (request: AcquireRequest) =>
  rpc<AcquireResponse>('/acquireSandbox', request);

export const releaseSandbox = (userKey: string) =>
  rpc<{ released: boolean }>('/releaseSandbox', { userKey });

// Swap the container, keep /home/user: the next use starts on the daemon's
// current base image.
export const rebuildSandbox = (userKey: string) =>
  rpc<{ sandbox: Sandbox }>('/rebuildSandbox', { userKey });

// The terminal's key: trades the session cookie for one sandbox's envd
// access token, so the browser can speak to the envd surface directly.
export const mintEnvdToken = (sandboxId: string) =>
  rpc<{ envdAccessToken: string }>('/console/envdToken', { sandboxId });
