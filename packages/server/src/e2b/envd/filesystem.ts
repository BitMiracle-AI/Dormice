import { resolveSandboxPath } from '@dormice/shared';
import type { FastifyInstance } from 'fastify';
import type { SandboxEntry } from '../../executor/executor';
import { connectError } from '../protocol';
import { type EnvdContext, sandboxIdOf } from './shared';

/** SandboxEntry -> proto3-JSON EntryInfo (int64 size travels as a string). */
export function entryInfoJson(entry: SandboxEntry) {
  return {
    name: entry.name,
    type:
      entry.type === 'file'
        ? 'FILE_TYPE_FILE'
        : entry.type === 'dir'
          ? 'FILE_TYPE_DIRECTORY'
          : 'FILE_TYPE_UNSPECIFIED',
    path: entry.path,
    size: String(entry.sizeBytes),
    mode: entry.mode,
    permissions: permissionString(entry),
    owner: entry.owner,
    group: entry.group,
    modifiedTime: entry.modifiedTime,
  };
}

/** Go fs.FileMode style: type char + rwx triplets, display only. */
function permissionString(entry: SandboxEntry): string {
  const chars =
    entry.type === 'dir' ? ['d'] : entry.type === 'file' ? ['-'] : ['?'];
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (entry.mode >> shift) & 0o7;
    chars.push(
      bits & 4 ? 'r' : '-',
      bits & 2 ? 'w' : '-',
      bits & 1 ? 'x' : '-',
    );
  }
  return chars.join('');
}

/** The unary half of the Filesystem service: Connect RPC, JSON codec. */
export function registerFilesystemRoutes(
  app: FastifyInstance,
  ctx: EnvdContext,
): void {
  const { executor } = ctx;

  app.post('/filesystem.Filesystem/Stat', async (request) => {
    const body = request.body as { path?: string };
    if (!body.path) throw connectError('invalid_argument', 'missing path');
    const entry = await ctx.inSlot(sandboxIdOf(request), (row) =>
      executor.statEntry(row.sandboxId, body.path as string),
    );
    return { entry: entryInfoJson(entry) };
  });

  app.post('/filesystem.Filesystem/ListDir', async (request) => {
    const body = request.body as { path?: string; depth?: number };
    if (!body.path) throw connectError('invalid_argument', 'missing path');
    const depth = body.depth ?? 1;
    if (depth < 1) {
      throw connectError('invalid_argument', 'depth should be at least one');
    }
    const entries = await ctx.inSlot(sandboxIdOf(request), (row) =>
      executor.listDir(row.sandboxId, body.path as string, depth),
    );
    return { entries: entries.map(entryInfoJson) };
  });

  app.post('/filesystem.Filesystem/MakeDir', async (request) => {
    const body = request.body as { path?: string };
    if (!body.path) throw connectError('invalid_argument', 'missing path');
    const entry = await ctx.inSlot(sandboxIdOf(request), async (row) => {
      const created = await executor.makeDir(
        row.sandboxId,
        body.path as string,
      );
      if (!created) {
        // The SDK reads already_exists as makeDir() === false.
        throw connectError(
          'already_exists',
          `already exists: ${resolveSandboxPath(body.path as string)}`,
        );
      }
      return executor.statEntry(row.sandboxId, body.path as string);
    });
    return { entry: entryInfoJson(entry) };
  });

  app.post('/filesystem.Filesystem/Move', async (request) => {
    const body = request.body as { source?: string; destination?: string };
    if (!body.source || !body.destination) {
      throw connectError('invalid_argument', 'missing source or destination');
    }
    const entry = await ctx.inSlot(sandboxIdOf(request), (row) =>
      executor.move(
        row.sandboxId,
        body.source as string,
        body.destination as string,
      ),
    );
    return { entry: entryInfoJson(entry) };
  });

  app.post('/filesystem.Filesystem/Remove', async (request) => {
    const body = request.body as { path?: string };
    if (!body.path) throw connectError('invalid_argument', 'missing path');
    await ctx.inSlot(sandboxIdOf(request), (row) =>
      executor.remove(row.sandboxId, body.path as string),
    );
    return {};
  });
}
