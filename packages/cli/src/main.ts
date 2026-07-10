#!/usr/bin/env node
// The bin entry, installed as both `dormice` (the full name people can
// guess) and `dor` (the short name people actually type). It only wires
// commander to the functions in commands.ts and prints their output —
// everything testable lives there.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import {
  clientFromEnv,
  pullSavedMessage,
  sandboxExec,
  sandboxLs,
  sandboxPull,
  sandboxPush,
  sandboxRebuild,
  sandboxRelease,
  templateAdd,
  templateLs,
  templateRm,
} from './commands';
import { realDoctorContext, runDoctor } from './doctor';

const program = new Command('dor').description(
  'Command-line tool for a Dormice daemon (also installed as `dormice`)',
);

program
  .command('doctor')
  .description('Check whether this host can run the Dormice daemon (read-only)')
  .option('--quick', 'skip the probes that start a real sandbox container')
  .action(async (opts: { quick?: boolean }) => {
    const { report, failed } = await runDoctor(realDoctorContext(), {
      quick: opts.quick,
    });
    console.log(report);
    if (failed) process.exitCode = 1;
  });

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
  .command('push')
  .description(
    'Copy a local file into the sandbox behind a key (wakes it first)',
  )
  .argument('<userKey>', 'the user key whose sandbox receives the file')
  .argument('<localPath>', 'local file to send')
  .argument(
    '[remotePath]',
    'destination inside the sandbox; relative paths land under /home/user (default: the local file name)',
  )
  .action(async (userKey: string, localPath: string, remotePath?: string) => {
    const content = await readFile(localPath);
    console.log(
      await sandboxPush(
        clientFromEnv(process.env),
        userKey,
        content,
        remotePath ?? path.basename(localPath),
      ),
    );
  });

sandbox
  .command('pull')
  .description('Copy a file out of the sandbox behind a key (wakes it first)')
  .argument('<userKey>', 'the user key whose sandbox holds the file')
  .argument('<remotePath>', 'file inside the sandbox; relative to /home/user')
  .argument('[localPath]', 'where to save it; omitted = raw bytes to stdout')
  .action(async (userKey: string, remotePath: string, localPath?: string) => {
    const result = await sandboxPull(
      clientFromEnv(process.env),
      userKey,
      remotePath,
    );
    if (localPath === undefined) {
      // Raw on purpose, like exec output: the operator's own file's bytes.
      process.stdout.write(result.content);
      return;
    }
    await writeFile(localPath, result.content);
    console.log(pullSavedMessage(result, localPath));
  });

sandbox
  .command('rebuild')
  .description(
    "Swap the container, keep /home/user — next use starts on the template's current image (or the base image)",
  )
  .argument('<userKey>', 'the user key whose sandbox to rebuild')
  .action(async (userKey: string) => {
    console.log(await sandboxRebuild(clientFromEnv(process.env), userKey));
  });

sandbox
  .command('release')
  .description('Destroy the sandbox behind a user key (idempotent)')
  .argument('<userKey>', 'the user key whose sandbox to destroy')
  .action(async (userKey: string) => {
    console.log(await sandboxRelease(clientFromEnv(process.env), userKey));
  });

const template = program
  .command('template')
  .description('Name Docker images on the daemon host as sandbox templates');

template
  .command('add')
  .description(
    'Register (or re-point — that is the upgrade) a template name to an image on the daemon host',
  )
  .argument('<name>', 'template name; doubles as the E2B templateID')
  .argument('<image>', 'Docker image reference, e.g. my-python:3.11')
  .action(async (name: string, image: string) => {
    console.log(await templateAdd(clientFromEnv(process.env), name, image));
  });

template
  .command('ls')
  .description('List every registered template')
  .action(async () => {
    console.log(await templateLs(clientFromEnv(process.env)));
  });

template
  .command('rm')
  .description(
    'Remove a template registration (refused while sandboxes still use it; never removes the image)',
  )
  .argument('<name>', 'template name to remove')
  .action(async (name: string) => {
    console.log(await templateRm(clientFromEnv(process.env), name));
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
