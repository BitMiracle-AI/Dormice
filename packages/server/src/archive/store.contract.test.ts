import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemStore } from './mem-store';
import { startMiniS3 } from './mini-s3';
import { S3Store } from './s3-store';
import { ArchiveObjectMissingError, type ArchiveStore } from './store';

/**
 * One exam, both stores — the executor contract's discipline. The S3 flavor
 * runs over the mini S3 on a real socket, so what CI pins is the real
 * aws-sdk wire, not a mock's idea of it.
 */

interface StoreSubject {
  store: ArchiveStore;
  close(): Promise<void>;
}

const subjects: Record<string, () => Promise<StoreSubject>> = {
  MemStore: async () => ({
    store: new MemStore(),
    close: async () => {},
  }),
  'S3Store over mini-S3': async () => {
    const mini = await startMiniS3();
    return {
      store: new S3Store({
        endpoint: mini.url,
        bucket: 'exam',
        accessKeyId: 'exam-key',
        secretAccessKey: 'exam-secret',
        region: 'us-east-1',
        forcePathStyle: true,
      }),
      close: () => mini.close(),
    };
  },
};

// Multi-KB and patterned: a real file stream is what triggers the SDK's
// checksum machinery (a string body never does — the predecessor system's
// pit #8 hid behind exactly that).
function payload(): Buffer {
  const buffer = Buffer.alloc(64 * 1024);
  for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 7) % 251;
  return buffer;
}

for (const [name, make] of Object.entries(subjects)) {
  describe(`archive store contract: ${name}`, () => {
    let subject: StoreSubject;
    let dir: string;

    beforeEach(async () => {
      subject = await make();
      dir = await mkdtemp(path.join(tmpdir(), 'dormice-store-'));
    });

    afterEach(async () => {
      await subject.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('round-trips a real file', async () => {
      const source = path.join(dir, 'source.bin');
      const dest = path.join(dir, 'dest.bin');
      await writeFile(source, payload());
      await subject.store.put('disks/round.tar.zst', source);
      await subject.store.get('disks/round.tar.zst', dest);
      expect((await readFile(dest)).equals(payload())).toBe(true);
    });

    it('overwrites the same key', async () => {
      const first = path.join(dir, 'first.bin');
      const second = path.join(dir, 'second.bin');
      const dest = path.join(dir, 'dest.bin');
      await writeFile(first, Buffer.from('the stale archive'));
      await writeFile(second, Buffer.from('the retried archive'));
      await subject.store.put('disks/again.tar.zst', first);
      // A crash between upload and the ledger transition retries the whole
      // archive — the overwrite is what makes that retry safe.
      await subject.store.put('disks/again.tar.zst', second);
      await subject.store.get('disks/again.tar.zst', dest);
      expect((await readFile(dest)).toString()).toBe('the retried archive');
    });

    it('get of a missing key throws the named error', async () => {
      await expect(
        subject.store.get('disks/never.tar.zst', path.join(dir, 'x')),
      ).rejects.toThrow(ArchiveObjectMissingError);
    });

    it('delete removes the object', async () => {
      const source = path.join(dir, 'source.bin');
      await writeFile(source, payload());
      await subject.store.put('disks/gone.tar.zst', source);
      await subject.store.delete('disks/gone.tar.zst');
      await expect(
        subject.store.get('disks/gone.tar.zst', path.join(dir, 'x')),
      ).rejects.toThrow(ArchiveObjectMissingError);
    });

    it('delete is idempotent', async () => {
      await expect(
        subject.store.delete('disks/never-was.tar.zst'),
      ).resolves.toBeUndefined();
    });

    it('get reports progress reaching 1', async () => {
      const source = path.join(dir, 'source.bin');
      await writeFile(source, payload());
      await subject.store.put('disks/meter.tar.zst', source);
      const fractions: number[] = [];
      await subject.store.get(
        'disks/meter.tar.zst',
        path.join(dir, 'dest.bin'),
        (f) => fractions.push(f),
      );
      expect(fractions.length).toBeGreaterThan(0);
      for (let i = 1; i < fractions.length; i++) {
        expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1] ?? 0);
      }
      expect(fractions.at(-1)).toBe(1);
    });
  });
}

describe('mini-S3 strictness', () => {
  it('rejects an SDK-default upload that negotiates checksums', async () => {
    // The guard of the guard: an SDK left on its defaults (WHEN_SUPPORTED)
    // negotiates flexible checksums — aws-chunked for streams, a checksum
    // header for buffered parts. If the mini S3 let either through, removing
    // WHEN_REQUIRED from S3Store would stay green and the pit-#8 pin would
    // be a dud.
    const mini = await startMiniS3();
    const dir = await mkdtemp(path.join(tmpdir(), 'dormice-store-'));
    try {
      const client = new S3Client({
        endpoint: mini.url,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: {
          accessKeyId: 'exam-key',
          secretAccessKey: 'exam-secret',
        },
      });
      const source = path.join(dir, 'source.bin');
      await writeFile(source, payload());
      await expect(
        new Upload({
          client,
          params: {
            Bucket: 'exam',
            Key: 'disks/default-config.tar.zst',
            Body: createReadStream(source),
          },
        }).done(),
      ).rejects.toThrow(/checksum negotiation is not supported/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await mini.close();
    }
  });
});
