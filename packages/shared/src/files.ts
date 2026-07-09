import { z } from 'zod';
import { userKeySchema } from './sandbox';

/**
 * Per-file size cap, write and read alike. Content crosses the wire as
 * base64 inside JSON — the whole file is buffered in daemon memory, so the
 * cap belongs to the protocol. Files beyond it are not this protocol's job:
 * fetch them from inside the sandbox (curl/wget via execCommand) instead of
 * pushing them through the daemon.
 */
export const FILE_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Request-body cap for writeFiles, the one total gate for a batch: base64
 * inflates content 4/3, so this admits roughly 32 MiB of decoded payload
 * plus JSON framing. A bigger project upload splits into several calls —
 * writes are per-file independent, nothing is lost by splitting.
 */
export const WRITE_FILES_BODY_LIMIT_BYTES = 48 * 1024 * 1024;

/**
 * Exact decoded size of a canonical (padded) base64 string — zod's z.base64()
 * guarantees the canonical form, so length arithmetic is precise and the
 * 16 MiB promise is exact, not "16 MiB give or take the padding".
 */
function base64DecodedBytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/**
 * A path inside the sandbox. Absolute, or relative — relative paths resolve
 * against /home/user, the same base execCommand's default cwd uses. NUL is
 * the one byte no filesystem path can contain.
 */
export const sandboxPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), { message: 'path must not contain NUL' });

/**
 * The protocol's single answer to "what does this path mean": absolute stays,
 * relative is joined to /home/user, `.`/`..`/repeated slashes normalize the
 * way a kernel would (`..` above the root clamps to the root — which is the
 * container's own root, so there is nothing to escape to). Pure string logic
 * on purpose: shared/ also runs in the browser, node:path does not.
 */
export function resolveSandboxPath(path: string): string {
  const absolute = path.startsWith('/') ? path : `/home/user/${path}`;
  const parts: string[] = [];
  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

const fileContentSchema = z
  .base64()
  .refine((value) => base64DecodedBytes(value) <= FILE_SIZE_LIMIT_BYTES, {
    message: `file content exceeds the ${FILE_SIZE_LIMIT_BYTES}-byte limit`,
  });

/**
 * writeFiles(userKey, files) — writes every file in the batch into the
 * sandbox behind the key, waking it first if it is cold. Parent directories
 * are created as needed; an existing file is overwritten. Writes happen in
 * array order and fail fast: on error the earlier files are already written
 * — the batch is a round-trip saver, not a transaction.
 */
export const writeFilesRequestSchema = z.object({
  userKey: userKeySchema,
  files: z
    .array(
      z.object({
        path: sandboxPathSchema,
        /** The file's bytes, base64. Text is just UTF-8 bytes — the SDK encodes strings transparently. */
        contentBase64: fileContentSchema,
      }),
    )
    .min(1),
});

export type WriteFilesRequest = z.infer<typeof writeFilesRequestSchema>;

export const writeFilesResponseSchema = z.object({
  /** What was written, with every path resolved to its absolute form. */
  files: z.array(z.object({ path: z.string() })),
});

export type WriteFilesResponse = z.infer<typeof writeFilesResponseSchema>;

/**
 * readFile(userKey, path) — returns one file's bytes. A file over the size
 * limit is refused outright (413 naming the actual size), never truncated:
 * unlike exec output, where a capped log still informs, a truncated file is
 * simply a corrupt file — an honest error beats delivering damaged goods.
 * Missing file: 404. Directory or other non-regular file: 400.
 */
export const readFileRequestSchema = z.object({
  userKey: userKeySchema,
  path: sandboxPathSchema,
});

export type ReadFileRequest = z.infer<typeof readFileRequestSchema>;

export const readFileResponseSchema = z.object({
  /** The path as resolved inside the sandbox, always absolute. */
  path: z.string(),
  contentBase64: z.base64(),
});

export type ReadFileResponse = z.infer<typeof readFileResponseSchema>;
