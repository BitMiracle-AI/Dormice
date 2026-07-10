/**
 * Where archived disks live. The store speaks object keys and local file
 * paths — nothing about sandboxes, states or executors: storage policy and
 * sandbox physicality stay on their own sides of the archiver.
 */
export interface ArchiveStore {
  /** Uploads the file at filePath under key, overwriting — retries are safe. */
  put(key: string, filePath: string): Promise<void>;
  /**
   * Downloads key into destPath (overwriting). onProgress reports a
   * monotonic fraction 0..1, best-effort. A missing object throws
   * ArchiveObjectMissingError — restore's honest "someone deleted it".
   */
  get(
    key: string,
    destPath: string,
    onProgress?: (fraction: number) => void,
  ): Promise<void>;
  /** Removes key. Idempotent: an absent object already is the goal state. */
  delete(key: string): Promise<void>;
}

/**
 * The object key an archived sandbox lives under. Derived, never stored —
 * the ledger needs no archive column because the id is the whole address.
 */
export function objectKey(sandboxId: string): string {
  return `disks/${sandboxId}.tar.zst`;
}

/** get() on a key that is not there — named so restore can log the culprit. */
export class ArchiveObjectMissingError extends Error {}
