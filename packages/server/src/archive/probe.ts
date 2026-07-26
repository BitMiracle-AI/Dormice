import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { S3Settings } from './s3-store';
import { S3Store } from './s3-store';

/** Thrown by probeS3 with the S3 error's own words and its HTTP status (when S3 answered at all). */
export class S3ProbeError extends Error {
  constructor(
    message: string,
    readonly httpStatusCode: number | undefined,
  ) {
    super(message);
  }
}

/**
 * A put+get+delete round trip against the candidate store, run BEFORE the
 * settings are written — a probe failure must leave the ledger untouched.
 * Deliberately the opposite of swap's save-then-reconcile: a swap target
 * that failed to apply is still the right target (capacity problems heal),
 * but S3 credentials are static facts — wrong ones saved would just turn
 * every later scan tick into error noise. Runs through S3Store itself
 * (real file streams, the same WHEN_REQUIRED checksum posture), so what
 * the probe proves is exactly what archiving will do.
 */
export async function probeS3(s3: S3Settings): Promise<void> {
  const store = new S3Store(s3);
  const dir = await mkdtemp(path.join(tmpdir(), 'dormice-s3-probe-'));
  const key = `dormice-probe-${randomUUID()}`;
  const body = 'dormice archive-store probe';
  try {
    const up = path.join(dir, 'up');
    const down = path.join(dir, 'down');
    await writeFile(up, body);
    try {
      await store.put(key, up);
      await store.get(key, down);
    } catch (error) {
      throw toProbeError(error);
    }
    if ((await readFile(down, 'utf8')) !== body) {
      throw new S3ProbeError(
        'the probe object came back with different content — the store is not a faithful S3',
        undefined,
      );
    }
  } finally {
    await store.delete(key).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

function toProbeError(error: unknown): S3ProbeError {
  if (error instanceof Error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    return new S3ProbeError(`${error.name}: ${error.message}`, status);
  }
  return new S3ProbeError(String(error), undefined);
}
