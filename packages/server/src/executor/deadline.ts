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
 * Single round-trips get wrapped here. An exec is bounded one level up:
 * its handshakes (exec create, exec start) are round-trips wrapped here,
 * and the wait for its end gets its own bound in the exec pipeline
 * (docker.ts waitForEnd, EXEC_END_GRACE_SECONDS below).
 *
 * A timed-out operation may still land later — a pause that answers at
 * t+130s still pauses the container. The ledger was not written (reality
 * first, ledger second), so that is ordinary drift, and the reconciler
 * repairs drift within one tick. The deadline leans on that existing net
 * instead of trying to undo anything itself — except for what no ledger
 * tracks: a late answer that is itself a resource (an exec start's attach
 * stream) goes to `release`, since the caller that gave up will never use
 * it.
 */
export function deadline<T>(
  work: Promise<T>,
  seconds: number,
  what: string,
  release?: (late: T) => void,
): Promise<T> {
  let expired = false;
  // The loser of the race may still settle long after the winner: a late
  // rejection must not surface as an unhandled one, and a late result is
  // released.
  work.then(
    (late) => {
      if (expired) release?.(late);
    },
    () => {},
  );
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(
          new Error(`${what} got no answer from dockerd within ${seconds}s`),
        );
      }, seconds * 1000);
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

/**
 * How long exitOf waits for the runtime to record an exit it can already
 * see has happened (the container's init dead on the host, or the kernel's
 * OOM verdict set) before concluding the shell is alive after all.
 * Measured 2026-09-09 on a gVisor host: Docker marks the container exited
 * 100-300ms after the sentry dies. Five seconds is an order of magnitude
 * of headroom for a loaded dockerd; the cost of a false "dying" read is
 * one such wait, never a wrong answer.
 */
export const EXIT_SETTLE_SECONDS = 5;

/**
 * How long dockerd may take to report an exec's end once its process can
 * no longer be running — the in-container deadline it runs under has
 * passed. The in-container `timeout` bounds the process; the end the
 * daemon waits for is dockerd's report of it (the output stream closing,
 * the exit code recorded), and dockerd reports the events of one container
 * one at a time: an exec whose output nobody reads parks that queue for
 * every exec of the container once it exits (moby #53614, open as of
 * Docker 29.8). Beijing, 2026-09-28: a MakeDir waited 36 hours for an end
 * that had happened in its first second, holding its sandbox's slot. The
 * same 30s the SDK adds to execCommand's own deadline on the client side.
 */
export const EXEC_END_GRACE_SECONDS = 30;
