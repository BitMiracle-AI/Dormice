import { afterEach, describe, expect, it, vi } from 'vitest';

function stubBrowser(options: { signedIn?: boolean } = {}) {
  const storage = new Map<string, string>();
  if (options.signedIn) storage.set('dormice.console.signed-in', '1');

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });

  const redirects: string[] = [];
  const location = {
    pathname: '/console/sandboxes/alice',
    search: '?tab=files',
    hash: '#preview',
    replace: (value: string) => redirects.push(value),
  };
  vi.stubGlobal('window', { location });
  return { storage, redirects };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function expectPending(promise: Promise<unknown>) {
  const fulfilled = vi.fn();
  const rejected = vi.fn();
  void promise.then(fulfilled, rejected);

  await Promise.resolve();
  await Promise.resolve();
  expect(fulfilled).not.toHaveBeenCalled();
  expect(rejected).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('console RPC transport', () => {
  it('returns a valid JSON response', async () => {
    stubBrowser();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ sandboxes: [] })),
    );
    const { listSandboxes } = await import('./api');

    await expect(listSandboxes()).resolves.toEqual({ sandboxes: [] });
  });

  it('throws a named ApiError with the daemon message', async () => {
    stubBrowser();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, 403)),
    );
    const { listSandboxes } = await import('./api');

    await expect(listSandboxes()).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'nope',
    });
  });

  it('falls back to route and status for a malformed error body', async () => {
    stubBrowser();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not json', { status: 500 })),
    );
    const { listSandboxes } = await import('./api');

    await expect(listSandboxes()).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: '/listSandboxes failed with 500',
    });
  });

  it.each([
    ['empty 200', new Response(null, { status: 200 })],
    ['malformed 200', new Response('not json', { status: 200 })],
    ['empty 204', new Response(null, { status: 204 })],
  ])('rejects %s instead of inventing a typed success', async (_label, res) => {
    stubBrowser();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    const { listSandboxes } = await import('./api');

    await expect(listSandboxes()).rejects.toMatchObject({
      name: 'ApiError',
      status: res.status,
      message: `/listSandboxes returned invalid JSON with ${res.status}`,
      cause: expect.anything(),
    });
  });

  it('redirects an expired session without settling the RPC', async () => {
    const { storage, redirects } = stubBrowser({ signedIn: true });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: 'missing or invalid API token' }, 401),
        ),
    );
    const { listSandboxes } = await import('./api');

    const request = listSandboxes();
    await expectPending(request);
    expect(storage.has('dormice.console.signed-in')).toBe(false);
    expect(redirects).toEqual([
      '/console/login?redirect=%2Fconsole%2Fsandboxes%2Falice%3Ftab%3Dfiles%23preview',
    ]);
  });

  it('holds concurrent 401s behind the same single redirect', async () => {
    const { redirects } = stubBrowser({ signedIn: true });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: 'missing or invalid API token' }, 401),
        ),
    );
    const { getConfig, listSandboxes } = await import('./api');

    const first = listSandboxes();
    const second = getConfig();
    await expectPending(first);
    await expectPending(second);
    expect(redirects).toHaveLength(1);
  });

  it('rejects a protected 401 when no signed-in marker exists', async () => {
    const { redirects } = stubBrowser();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'unauthorized' }, 401)),
    );
    const { listSandboxes } = await import('./api');

    await expect(listSandboxes()).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      message: 'unauthorized',
    });
    expect(redirects).toEqual([]);
  });

  it('keeps login 401s local to the form', async () => {
    const { storage, redirects } = stubBrowser({ signedIn: true });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: 'invalid username or password' }, 401),
        ),
    );
    const { login } = await import('./api');

    await expect(
      login({ username: 'x', password: 'wrongpass' }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      message: 'invalid username or password',
    });
    expect(storage.has('dormice.console.signed-in')).toBe(true);
    expect(redirects).toEqual([]);
  });
});
