import type { Sandbox } from '@dormice/shared';

/**
 * The console talks to the daemon's native RPC routes — the same routes,
 * same truth as the SDK and CLI — authenticated by the httpOnly session
 * cookie the browser attaches on its own. The custom header is the second
 * half of the CSRF defense: a cross-origin page cannot send it without a
 * CORS preflight, and the daemon answers no preflights.
 */
export class UnauthorizedError extends Error {}

async function rpc<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dormice-console': '1',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    throw new UnauthorizedError('not logged in');
  }
  if (!res.ok) {
    const message = await res
      .json()
      .then((data: { message?: string }) => data.message)
      .catch(() => undefined);
    throw new Error(message ?? `${path} failed with ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const login = (token: string) =>
  rpc<{ loggedIn: true }>('/ui/auth/login', { token });

export const logout = () => rpc<{ loggedIn: false }>('/ui/auth/logout');

export const listSandboxes = () =>
  rpc<{ sandboxes: Sandbox[] }>('/listSandboxes');

export const releaseSandbox = (userKey: string) =>
  rpc<{ released: boolean }>('/releaseSandbox', { userKey });
