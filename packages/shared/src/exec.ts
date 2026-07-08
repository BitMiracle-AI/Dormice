import { z } from 'zod';
import { userKeySchema } from './sandbox';

/** In-container deadline applied when the caller does not set one. */
export const DEFAULT_EXEC_TIMEOUT_SECONDS = 300;

/** Hard ceiling, one day — beyond this the buffered protocol is the wrong tool. */
export const MAX_EXEC_TIMEOUT_SECONDS = 86_400;

/**
 * Per-stream output cap. The whole result is buffered in daemon memory, so
 * the cap belongs to the protocol, not to any one executor — both executors
 * enforce it identically and the contract exam holds them to it. Truncation
 * is reported, never silent.
 */
export const EXEC_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/**
 * execCommand(userKey, command) — runs a shell command inside the sandbox
 * behind the key and waits for it to finish. A cold (frozen/stopped) sandbox
 * is woken first; a running command counts as activity, so the idle scanner
 * never freezes a sandbox mid-command.
 */
export const execCommandRequestSchema = z.object({
  userKey: userKeySchema,
  /** A shell string, executed as `bash -c <command>` inside the sandbox. */
  command: z.string().min(1),
  /**
   * Enforced inside the container (a host-side disconnect cannot kill the
   * in-container process); on expiry the command is SIGKILLed → exit 137.
   */
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(MAX_EXEC_TIMEOUT_SECONDS)
    .default(DEFAULT_EXEC_TIMEOUT_SECONDS),
  /** Working directory inside the sandbox; defaults to the image's /home/user. */
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type ExecCommandRequest = z.infer<typeof execCommandRequestSchema>;

export const execCommandResponseSchema = z.object({
  /**
   * The command's honest exit code — a nonzero exit is a result, not an
   * error. 137 means SIGKILL: usually the timeout, but also an in-sandbox
   * OOM kill; the daemon cannot tell them apart and deliberately does not
   * pretend to (no timedOut flag).
   */
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
});

export type ExecCommandResponse = z.infer<typeof execCommandResponseSchema>;
