import type { Db } from '../db/db';
import { readS3Settings } from '../db/settings';
import type { ArchiveStoreProvider } from './archiver';
import { S3Store } from './s3-store';
import type { ArchiveStore } from './store';

/**
 * The production ArchiveStoreProvider: the ledger's S3 settings, asked
 * live. Purely derived — updateSettings writes the ledger and broadcasts
 * nothing; the next transfer, destroy or enabled() check simply reads the
 * new answer here (the same getter-closure discipline as the executor's
 * `resources` knob). The S3Client is rebuilt only when the six-tuple
 * actually changes: it holds a connection pool worth keeping across the
 * scanner's every-tick enabled() probes.
 */
export class LedgerArchiveStore implements ArchiveStoreProvider {
  private cacheKey: string | null = null;
  private cached: S3Store | null = null;

  constructor(private readonly db: Db) {}

  current(): ArchiveStore | null {
    const s3 = readS3Settings(this.db);
    if (s3 === null) {
      this.cacheKey = null;
      this.cached = null;
      return null;
    }
    const key = JSON.stringify(s3);
    if (key !== this.cacheKey) {
      this.cached = new S3Store(s3);
      this.cacheKey = key;
    }
    return this.cached;
  }
}
