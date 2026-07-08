/**
 * Sandbox lifecycle. Each state one rung colder than the last:
 *
 *   active   — container running, serving requests
 *   frozen   — paused, memory squeezed out to swap (~50ms to wake)
 *   stopped  — processes gone; the disk — the sandbox's durable data —
 *              survives, and waking rebuilds the container around it
 *              (seconds)
 *   archived — disk compressed to S3, local copy freed (minutes to wake)
 *
 * `restoring` is the transitional state while an archived sandbox is
 * being downloaded and unpacked. acquire() returns it immediately with
 * progress instead of blocking — slow wake-ups must be honest.
 */
export const SANDBOX_STATES = [
  'active',
  'frozen',
  'stopped',
  'archived',
  'restoring',
] as const;

export type SandboxState = (typeof SANDBOX_STATES)[number];
