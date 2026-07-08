#!/usr/bin/env node
// The bin entry, installed as both `dormice` (the full name people can
// guess) and `dor` (the short name people actually type). It only wires
// commander to the functions in commands.ts and prints their output —
// everything testable lives there.
import { Command } from 'commander';
import {
  clientFromEnv,
  sandboxExec,
  sandboxLs,
  sandboxRelease,
} from './commands';

const program = new Command('dor').description(
  'Command-line tool for a Dormice daemon (also installed as `dormice`)',
);

const sandbox = program
  .command('sandbox')
  .description('Inspect and manage sandboxes');

sandbox
  .command('ls')
  .description('List every sandbox with its current lifecycle state')
  .action(async () => {
    console.log(await sandboxLs(clientFromEnv(process.env)));
  });

sandbox
  .command('exec')
  .description(
    'Run a shell command inside the sandbox behind a key (wakes it first)',
  )
  .argument('<userKey>', 'the user key whose sandbox runs the command')
  .argument(
    '<command>',
    'shell command, quoted as one argument (runs as bash -c)',
  )
  .option(
    '-t, --timeout <seconds>',
    'kill the command after this many seconds',
    (value: string) => Number(value),
  )
  .action(
    async (userKey: string, command: string, opts: { timeout?: number }) => {
      const result = await sandboxExec(
        clientFromEnv(process.env),
        userKey,
        command,
        opts.timeout,
      );
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    },
  );

sandbox
  .command('release')
  .description('Destroy the sandbox behind a user key (idempotent)')
  .argument('<userKey>', 'the user key whose sandbox to destroy')
  .action(async (userKey: string) => {
    console.log(await sandboxRelease(clientFromEnv(process.env), userKey));
  });

try {
  await program.parseAsync();
} catch (error) {
  // One honest line on stderr; a stack trace helps nobody at a shell prompt.
  console.error(
    `dor: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
