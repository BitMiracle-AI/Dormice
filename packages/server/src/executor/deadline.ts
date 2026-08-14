/**
 * Bounds one Docker API round-trip with an explicit deadline.
 *
 * Why this exists (2026-08-13, Beijing production): one dockerode call lost
 * its response — the socket was already closed, the callback never fired, so
 * the pending promise held no fd, no child process, nothing observable — and
 * the daemon's chained heartbeat awaited it forever. Eleven hours of zero
 * freezes while wakes kept landing; 643 sandboxes piled up active. The
 * defect is the client library's implicit "wait forever": a lost response is
 * indistinguishable from a slow one, and no catch block ever hears about it.
 *
 * The cure is not to fix the race (it lives inside the library) but to make
 * its outcome loud: with a deadline, a lost response becomes an error the
 * existing failure paths already digest — the scanner retries next sweep,
 * an HTTP verb answers 500, nothing stalls silently.
 *
 * Only single round-trips get wrapped. Exec/attach streams live as long as
 * the command they carry and own their bounds elsewhere (script-level
 * timeouts); their handshakes (exec create, exec start) are round-trips and
 * are wrapped.
 *
 * A timed-out operation may still land later — a pause that answers at
 * t+130s still pauses the container. The ledger was not written (reality
 * first, ledger second), so that is ordinary drift, and the reconciler
 * repairs drift within one tick. The deadline leans on that existing net
 * instead of trying to undo anything itself.
 */
export function deadline<T>(
  work: Promise<T>,
  seconds: number,
  what: string,
): Promise<T> {
  // The loser of the race may still reject long after the winner settled;
  // that late rejection must not surface as an unhandled one.
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`${what} got no answer from dockerd within ${seconds}s`),
          ),
        seconds * 1000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Pure reads: inspect, list, one stats sample (~1s by design). */
export const QUERY_DEADLINE_SECONDS = 30;

/**
 * State changes: create, start, pause, unpause, kill, remove, exec
 * handshakes. Generous on purpose — under a wake storm dockerd has answered
 * legitimate verbs in tens of seconds, and a false failure costs a retry;
 * the deadline only needs to turn "forever" into "minutes".
 */
export const VERB_DEADLINE_SECONDS = 120;

/**
 * wait(not-running) after SIGKILL. A gVisor box exits in seconds once the
 * kill lands; the extra headroom is for an I/O-saturated host, not for the
 * exit itself.
 */
export const WAIT_DEADLINE_SECONDS = 180;
