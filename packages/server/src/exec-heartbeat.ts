import type { Db } from './db/db';
import { touch } from './db/ledger';

/**
 * Keeps a sandbox's idle clock fresh while an exec (or a long file stream)
 * is in flight, so the scanner never freezes a container that is
 * mid-command. Half the freeze threshold (never above 10s) lands at least
 * one touch inside every scan window, down to the schema's minimum
 * freezeAfterSeconds of 1. A vanished row (released mid-exec) stops the
 * timer — the exec itself will fail with its own honest error; an unhandled
 * throw inside setInterval would take the daemon down instead.
 */
export function startExecHeartbeat(
  db: Db,
  sandboxId: string,
  freezeAfterSeconds: number,
): () => void {
  const intervalMs = Math.min((freezeAfterSeconds * 1000) / 2, 10_000);
  const timer = setInterval(() => {
    try {
      touch(db, sandboxId);
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
