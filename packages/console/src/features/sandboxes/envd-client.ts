/**
 * Browser-side client for the daemon's envd surface beyond the PTY: the
 * unary Filesystem/Process RPCs and the plain-HTTP file faces — the exact
 * wire the official e2b SDK speaks (see envd-pty.ts for why: a console-only
 * endpoint would be a second truth). Everything authenticates with the
 * per-sandbox envd access token minted via /console/envdToken.
 *
 * Waking: the unary filesystem verbs wake a frozen sandbox (using files IS
 * using the sandbox); Process/List is read-only and never wakes. Callers
 * gate the first filesystem call behind an explicit user action.
 */

const ENVD = '/e2b/envd';

export interface EnvdAuth {
  sandboxId: string;
  envdAccessToken: string;
}

function headersOf(auth: EnvdAuth): Record<string, string> {
  return {
    'e2b-sandbox-id': auth.sandboxId,
    'x-access-token': auth.envdAccessToken,
  };
}

export class EnvdError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
  }
}

async function unary<T>(
  auth: EnvdAuth,
  rpc: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${ENVD}/${rpc}`, {
    method: 'POST',
    headers: { ...headersOf(auth), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => undefined)) as
      | { code?: string; message?: string }
      | undefined;
    throw new EnvdError(
      detail?.message ?? `${rpc} 请求失败(${res.status})`,
      detail?.code,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

// ---- Filesystem(unary Connect RPC,JSON 编码)---------------------------

/** proto3-JSON 的 EntryInfo:int64 的 size 在 wire 上是字符串。 */
export interface EnvdEntry {
  name: string;
  type: 'FILE_TYPE_FILE' | 'FILE_TYPE_DIRECTORY' | 'FILE_TYPE_UNSPECIFIED';
  path: string;
  size: string;
  mode: number;
  permissions: string;
  owner: string;
  group: string;
  modifiedTime: string;
}

export const listDir = (auth: EnvdAuth, path: string) =>
  unary<{ entries: EnvdEntry[] }>(auth, 'filesystem.Filesystem/ListDir', {
    path,
  }).then((r) => r.entries);

export const makeDir = (auth: EnvdAuth, path: string) =>
  unary<{ entry: EnvdEntry }>(auth, 'filesystem.Filesystem/MakeDir', { path });

export const moveEntry = (
  auth: EnvdAuth,
  source: string,
  destination: string,
) =>
  unary<{ entry: EnvdEntry }>(auth, 'filesystem.Filesystem/Move', {
    source,
    destination,
  });

export const removeEntry = (auth: EnvdAuth, path: string) =>
  unary<Record<string, never>>(auth, 'filesystem.Filesystem/Remove', { path });

// ---- 文件本体进出(纯 HTTP 面,流式无大小上限)---------------------------

/** 下载整个文件为 Blob,交给浏览器落盘。 */
export async function downloadFile(
  auth: EnvdAuth,
  path: string,
): Promise<Blob> {
  const query = new URLSearchParams({ path, username: 'user' });
  const res = await fetch(`${ENVD}/files?${query}`, {
    headers: headersOf(auth),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => undefined)) as
      | { message?: string }
      | undefined;
    throw new EnvdError(
      detail?.message ?? `下载失败(${res.status})`,
      undefined,
      res.status,
    );
  }
  return res.blob();
}

/** octet-stream 直传:目标路径在 query,body 就是文件字节。 */
export async function uploadFile(
  auth: EnvdAuth,
  path: string,
  file: File,
): Promise<void> {
  const query = new URLSearchParams({ path, username: 'user' });
  const res = await fetch(`${ENVD}/files?${query}`, {
    method: 'POST',
    headers: { ...headersOf(auth), 'content-type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => undefined)) as
      | { message?: string }
      | undefined;
    throw new EnvdError(
      detail?.message ?? `上传失败(${res.status})`,
      undefined,
      res.status,
    );
  }
}

// ---- Process(unary 部分;流式的 Start 归 envd-pty.ts)--------------------

export interface EnvdProcess {
  pid: number;
  config: {
    cmd: string;
    args: string[];
    envs?: Record<string, string>;
    cwd?: string;
  };
}

/** 只读不唤醒:看进程表绝不解冻沙箱。 */
export const listProcesses = (auth: EnvdAuth) =>
  unary<{ processes: EnvdProcess[] }>(auth, 'process.Process/List', {}).then(
    (r) => r.processes,
  );

export const killProcess = (
  auth: EnvdAuth,
  pid: number,
  signal: 'SIGNAL_SIGTERM' | 'SIGNAL_SIGKILL',
) =>
  unary<Record<string, never>>(auth, 'process.Process/SendSignal', {
    process: { pid },
    signal,
  });
