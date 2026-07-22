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
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

async function unary<T>(
  auth: EnvdAuth,
  rpc: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${ENVD}/${rpc}`, {
    method: 'POST',
    headers: {
      ...headersOf(auth),
      ...extraHeaders,
      'content-type': 'application/json',
    },
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
  try {
    return (await res.json()) as T;
  } catch (error) {
    throw new EnvdError(
      `${rpc} 响应无效`,
      undefined,
      0,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
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

// ---- 目录监听(轮询三动词:create → drain → remove)------------------------
//
// 与官方 SDK 的流式 WatchDir 同一张水源,轮询形态对浏览器更顺:没有长连
// 接要养,GetWatcherEvents 一次拿走积压(drained means drained),404 =
// 监听器随容器一起没了(冻结/重建都会),调用方重建一个就是。

export interface EnvdWatchEvent {
  name: string;
  type: string;
}

export const createWatcher = (
  auth: EnvdAuth,
  path: string,
  operationId: string,
) =>
  unary<{ watcherId: string }>(
    auth,
    'filesystem.Filesystem/CreateWatcher',
    { path },
    { 'x-dormice-watcher-operation-id': operationId },
  ).then((r) => r.watcherId);

/** 只读不唤醒(与 Process/List 同一原则):挂着监听不养沙箱的体温。 */
export const getWatcherEvents = (auth: EnvdAuth, watcherId: string) =>
  unary<{ events?: EnvdWatchEvent[] }>(
    auth,
    'filesystem.Filesystem/GetWatcherEvents',
    { watcherId },
  ).then((r) => r.events ?? []);

export const removeWatcher = (auth: EnvdAuth, watcherId: string) =>
  unary<Record<string, never>>(auth, 'filesystem.Filesystem/RemoveWatcher', {
    watcherId,
  });

// ---- 文件本体进出(纯 HTTP 面,流式无大小上限)---------------------------

/** 下载整个文件为 Blob,交给浏览器落盘或就地预览。 */
export async function downloadFile(
  auth: EnvdAuth,
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const query = new URLSearchParams({ path, username: 'user' });
  const res = await fetch(`${ENVD}/files?${query}`, {
    headers: headersOf(auth),
    signal,
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

// ---- 签名直链(daemon 根 /files,给第三方抓取用)---------------------------

/**
 * 15 分钟:Microsoft 查看器加载时抓取、大文档翻页可能补抓,太短会断
 * 查看器的懒加载;再长只是白白加宽泄露窗 — 每次点击/刷新都重铸,
 * 过期是一次点击的事。
 */
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

/**
 * 浏览器侧复算签名直链 — 与 server/e2b/signing.ts 的 fileSignature
 * 逐字对齐:`"v1_" + base64标准字母表剥padding( sha256(
 * path:read:<username>:<token>:<exp> ) )`。浏览器本就持有本沙箱的
 * envdAccessToken(它就是签名材料,秘密 signing secret 从不出 daemon),
 * 所以不需要新的服务端动词。
 *
 * username 位置是空字符串,且 URL 里绝不带 username 参数:服务端校验
 * 材料默认 `query.username ?? ''`,但 vetUsername('') 会 throw — 带空
 * `username=` 是 401,带 `username=user` 则材料对不上,两头只能"缺席"
 * (e2e/console.test 反向钉着这一条)。
 *
 * crypto.subtle 只在安全上下文存在(明文 HTTP 的 IP 访问没有)—
 * 调用方先闸 window.isSecureContext。
 */
export async function signedDownloadUrl(
  auth: EnvdAuth,
  path: string,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;
  const material = `${path}:read::${auth.envdAccessToken}:${exp}`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(material),
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(
    /=+$/,
    '',
  );
  const query = new URLSearchParams({
    path,
    signature: `v1_${b64}`,
    signature_expiration: String(exp),
  });
  // daemon 根,不带 /e2b/envd 前缀 — 签名面刻意开在根上(见 server 的
  // signed-files.ts 顶注);控制台与它同源,origin 即公网地址。
  return `${window.location.origin}/files?${query}`;
}
