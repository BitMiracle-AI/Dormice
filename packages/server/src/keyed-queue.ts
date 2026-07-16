/** What tryRun returns when the key was busy and the task never ran. */
export const SKIPPED: unique symbol = Symbol('skipped');

/**
 * The single serialization point for everything that operates on one
 * sandbox: acquire, destroy, the idle scanner's cooling moves and the
 * reconciler's repairs all take the sandbox's name slot before they
 * check-then-act. Each of those verbs has seconds of executor work between
 * its check and its act (create builds a disk, freeze can hold 45s in
 * memory.reclaim), and interleaving in that gap produced real corruption:
 * an acquire answering "ready" while the scanner was mid-freeze, two
 * destroys racing one removal into a 500.
 *
 * One in-memory map suffices because the daemon is single-process by
 * design; different keys never wait on each other.
 */
export class KeyedQueue {
  /** Per-key chain tails; entries are removed once a chain fully settles. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Queues `task` behind everything already running under `key` and returns
   * its result. Rejections propagate to the caller and never block the
   * queue for the next task.
   */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key);
    // The stored tail never rejects (see below), so a plain then() chains.
    const next = prev === undefined ? task() : prev.then(task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    tail.then(() => {
      // Only the last chain link cleans up — a newer task may have replaced
      // the tail while this one was still settling.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return next;
  }

  /**
   * Runs `task` only when nothing holds the key right now; otherwise skips
   * and returns SKIPPED. For background actors (scanner, reconciler): a busy
   * key means the sandbox is mid-operation and any observation about it is
   * already stale — the honest move is to wait for the next tick, not to
   * queue up a stale decision behind the operation that invalidated it.
   */
  async tryRun<T>(
    key: string,
    task: () => Promise<T>,
  ): Promise<T | typeof SKIPPED> {
    if (this.tails.has(key)) {
      return SKIPPED;
    }
    return this.run(key, task);
  }
}
