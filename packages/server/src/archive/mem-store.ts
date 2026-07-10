import { readFile, writeFile } from 'node:fs/promises';
import { ArchiveObjectMissingError, type ArchiveStore } from './store';

/**
 * The permanent test double (FakeExecutor's discipline): objects in memory,
 * but the file ends are real — the archiver hands this store the same real
 * paths it hands S3Store, so what unit tests exercise is the same plumbing.
 */
export class MemStore implements ArchiveStore {
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, filePath: string): Promise<void> {
    this.objects.set(key, await readFile(filePath));
  }

  async get(
    key: string,
    destPath: string,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    const body = this.objects.get(key);
    if (body === undefined) {
      throw new ArchiveObjectMissingError(
        `archive object ${key} is not in bucket mem`,
      );
    }
    await writeFile(destPath, body);
    onProgress?.(1);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** Test hook: is the object there? */
  has(key: string): boolean {
    return this.objects.has(key);
  }

  /** Test hook: how many objects the store holds. */
  get size(): number {
    return this.objects.size;
  }
}
