import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireSingleWriterLock } from './lock';

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'dormice-lock-')), 'dormice.db');
}

describe('acquireSingleWriterLock', () => {
  it('lets the first daemon in and names the conflict for the second', () => {
    const dbPath = tempDbPath();
    const first = acquireSingleWriterLock(dbPath);
    try {
      expect(() => acquireSingleWriterLock(dbPath)).toThrow(
        /another daemon is already running/,
      );
    } finally {
      first.close();
    }
  });

  it('frees the lock when the holder goes away', () => {
    const dbPath = tempDbPath();
    const first = acquireSingleWriterLock(dbPath);
    first.close();
    const second = acquireSingleWriterLock(dbPath);
    second.close();
  });

  it('different ledgers do not contend', () => {
    const a = acquireSingleWriterLock(tempDbPath());
    const b = acquireSingleWriterLock(tempDbPath());
    a.close();
    b.close();
  });
});
