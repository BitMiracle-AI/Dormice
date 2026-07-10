/**
 * A browser-side client for the daemon's envd PTY surface — the exact wire
 * the official e2b SDK speaks, reused instead of inventing a console-only
 * terminal endpoint (a second protocol would be a second truth). Output is
 * one streaming Connect RPC (Process/Start with a pty block); keystrokes,
 * resizes and the kill are plain unary calls. All of it is fetch — no
 * WebSocket, so it works through any proxy plain HTTP works through.
 */

const ENVD = '/e2b/envd';

/** Connect streaming envelope flags, mirrored from the server's protocol.ts. */
const FLAG_END_STREAM = 0x02;

export interface PtySize {
  cols: number;
  rows: number;
}

export interface PtyCallbacks {
  /** Raw terminal output — bytes for xterm.write, straight off the wire. */
  onData: (bytes: Uint8Array) => void;
  /**
   * The session is over, whichever way: the shell exited, the stream
   * errored, or the sandbox died under it. Fires exactly once.
   */
  onClose: (reason: string) => void;
}

export interface PtySession {
  /** Keyboard input, exactly as xterm's onData hands it over. */
  write(data: string): void;
  resize(size: PtySize): void;
  /** Kill the shell and drop the stream. Safe to call more than once. */
  close(): Promise<void>;
}

/** 1 flag byte + 4-byte big-endian length + JSON — the Connect JSON codec. */
function envelope(json: unknown): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(JSON.stringify(json));
  const buf = new Uint8Array(5 + payload.length);
  new DataView(buf.buffer).setUint32(1, payload.length);
  buf.set(payload, 5);
  return buf;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** What a data/end/error frame can carry — the slice of the stream we read. */
interface StreamFrame {
  event?: {
    start?: { pid?: number };
    data?: { pty?: string };
    end?: { exitCode?: number; status?: string };
  };
  error?: { code?: string; message?: string };
}

/**
 * Opens an interactive bash in the sandbox and resolves once the shell has
 * actually started (the stream's start frame carries the pid the unary
 * calls need). Opening wakes a frozen sandbox — callers gate this behind an
 * explicit user action, because merely looking at a sandbox must not thaw it.
 */
export async function openPty(options: {
  sandboxId: string;
  envdAccessToken: string;
  size: PtySize;
  callbacks: PtyCallbacks;
}): Promise<PtySession> {
  const { sandboxId, envdAccessToken, size, callbacks } = options;
  const headers = {
    'e2b-sandbox-id': sandboxId,
    'x-access-token': envdAccessToken,
  };

  async function unary(rpc: string, body: unknown): Promise<void> {
    const res = await fetch(`${ENVD}/process.Process/${rpc}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => undefined)) as
        | { message?: string }
        | undefined;
      throw new Error(detail?.message ?? `${rpc} 请求失败(${res.status})`);
    }
  }

  const abort = new AbortController();
  const res = await fetch(`${ENVD}/process.Process/Start`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/connect+json' },
    // The shape the e2b SDK sends for a terminal; the daemon accepts no
    // other. TERM travels as an env because there is no tty inheritance.
    body: envelope({
      process: {
        cmd: '/bin/bash',
        args: ['-i', '-l'],
        envs: { TERM: 'xterm-256color' },
      },
      pty: { size },
    }),
    signal: abort.signal,
  });
  if (!res.ok || !res.body) {
    const detail = (await res.json().catch(() => undefined)) as
      | { message?: string }
      | undefined;
    throw new Error(detail?.message ?? `终端连接失败(${res.status})`);
  }

  let closed = false;
  const closeOnce = (reason: string) => {
    if (closed) return;
    closed = true;
    abort.abort();
    callbacks.onClose(reason);
  };

  // Frames arrive fragmented and coalesced at TCP's whim; buffer and slice.
  let buffer = new Uint8Array(0);
  const handleFrame = (
    flags: number,
    frame: StreamFrame,
  ): number | undefined => {
    if (flags & FLAG_END_STREAM) {
      closeOnce(frame.error?.message ?? '连接已断开');
      return;
    }
    if (frame.event?.data?.pty) {
      callbacks.onData(fromBase64(frame.event.data.pty));
    }
    if (frame.event?.end) {
      closeOnce(`shell 已退出(码 ${frame.event.end.exitCode ?? '?'})`);
    }
    return frame.event?.start?.pid;
  };

  const reader = res.body.getReader();
  const pumpFrames = async (until?: 'start'): Promise<number | undefined> => {
    for (;;) {
      while (buffer.length >= 5) {
        const view = new DataView(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength,
        );
        const length = view.getUint32(1);
        if (buffer.length < 5 + length) break;
        const json = JSON.parse(
          new TextDecoder().decode(buffer.subarray(5, 5 + length)),
        ) as StreamFrame;
        const flags = view.getUint8(0);
        buffer = buffer.slice(5 + length);
        const pid = handleFrame(flags, json);
        if (closed) return undefined;
        if (until === 'start' && typeof pid === 'number') return pid;
      }
      const { done, value } = await reader.read();
      if (done) {
        closeOnce('连接已断开');
        return undefined;
      }
      const grown = new Uint8Array(buffer.length + value.length);
      grown.set(buffer);
      grown.set(value, buffer.length);
      buffer = grown;
    }
  };

  // The start frame is the daemon's promise that bash is running; anything
  // else first (an in-stream error, an early close) fails the open.
  let pid: number | undefined;
  try {
    pid = await pumpFrames('start');
  } catch (error) {
    closeOnce(error instanceof Error ? error.message : String(error));
  }
  if (pid === undefined) {
    throw new Error('终端没有启动');
  }
  const startedPid = pid;

  // Keep draining in the background for the life of the session.
  pumpFrames().catch((error: unknown) => {
    // An aborted fetch rejects; that is close() doing its job, not news.
    if (!closed) {
      closeOnce(error instanceof Error ? error.message : String(error));
    }
  });

  // Keystrokes are separate POSTs, and the browser may spread them over
  // several connections — chained here so they cannot arrive reordered.
  let inputChain: Promise<void> = Promise.resolve();

  return {
    write(data: string) {
      const input = toBase64(new TextEncoder().encode(data));
      inputChain = inputChain
        .then(() =>
          unary('SendInput', {
            process: { pid: startedPid },
            input: { pty: input },
          }),
        )
        .catch(() => {
          // A failed keystroke on a dying session; the stream's own close
          // tells the story.
        });
    },
    resize(next: PtySize) {
      void unary('Update', {
        process: { pid: startedPid },
        pty: { size: next },
      }).catch(() => undefined);
    },
    async close() {
      if (closed) return;
      // Kill first, then drop the stream: an abandoned bash would otherwise
      // sit in the process table until the sandbox stops.
      await unary('SendSignal', {
        process: { pid: startedPid },
        signal: 'SIGNAL_SIGKILL',
      }).catch(() => undefined);
      closeOnce('终端已关闭');
    },
  };
}
