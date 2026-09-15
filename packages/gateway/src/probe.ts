import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type S3Settings, S3Store } from '@dormice/server/s3-store';

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
 * settings are written — a probe failure must leave the table untouched:
 * S3 credentials are static facts, and wrong ones saved would turn every
 * node's next archive tick into error noise. The gateway probes itself,
 * as the authority that is about to write the store every node will use
 * (a node could probe on its behalf, but the one who writes the fact is
 * the one who checks it). Runs through the daemon's own S3Store (real
 * file streams, the same WHEN_REQUIRED checksum posture), so what the
 * probe proves is exactly what archiving on a node will do.
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
