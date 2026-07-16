#!/usr/bin/env node
// The bin entry, installed as both `dormice` (the full name people can
// guess) and `dor` (the short name people actually type). It only wires
// commander to the functions in commands.ts and prints their output —
// everything testable lives there.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import {
  apikeyCreate,
  apikeyDisable,
  apikeyEnable,
  apikeyLs,
  apikeyRevoke,
  clientFromEnv,
  parseLabels,
  pullSavedMessage,
  sandboxDestroy,
  sandboxExec,
  sandboxLs,
  sandboxMeta,
  sandboxPull,
  sandboxPush,
  sandboxRebuild,
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
  .argument('<name>', 'the sandbox name to run the command in')
  .argument(
    '<command>',
    'shell command, quoted as one argument (runs as bash -c)',
  )
  .option(
    '-t, --timeout <seconds>',
    'kill the command after this many seconds',
    (value: string) => Number(value),
  )
  .action(async (name: string, command: string, opts: { timeout?: number }) => {
    const result = await sandboxExec(
      clientFromEnv(process.env),
      name,
      command,
      opts.timeout,
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  });

sandbox
  .command('push')
  .description(
    'Copy a local file into the sandbox behind a key (wakes it first)',
  )
  .argument('<name>', 'the sandbox name to push the file into')
  .argument('<localPath>', 'local file to send')
  .argument(
    '[remotePath]',
    'destination inside the sandbox; relative paths land under /home/user (default: the local file name)',
  )
  .action(async (name: string, localPath: string, remotePath?: string) => {
    const content = await readFile(localPath);
    console.log(
      await sandboxPush(
        clientFromEnv(process.env),
        name,
        content,
        remotePath ?? path.basename(localPath),
      ),
    );
  });

sandbox
  .command('pull')
  .description('Copy a file out of the sandbox behind a key (wakes it first)')
  .argument('<name>', 'the sandbox name to pull the file from')
  .argument('<remotePath>', 'file inside the sandbox; relative to /home/user')
  .argument('[localPath]', 'where to save it; omitted = raw bytes to stdout')
  .action(async (name: string, remotePath: string, localPath?: string) => {
    const result = await sandboxPull(
      clientFromEnv(process.env),
      name,
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
  .command('meta')
  .description(
    'Show or replace the labels on the sandbox behind a key (replacement is total; a pure ledger write, nothing is woken)',
  )
  .argument('<name>', 'the sandbox name to label')
  .argument(
    '[labels...]',
    'key=value pairs forming the NEW complete label set; omitted = show the current one',
  )
  .option('--clear', 'remove every label')
  .action(async (name: string, labels: string[], opts: { clear?: boolean }) => {
    if (opts.clear && labels.length > 0) {
      throw new Error('--clear and key=value labels are mutually exclusive');
    }
    console.log(
      await sandboxMeta(
        clientFromEnv(process.env),
        name,
        opts.clear ? {} : labels.length > 0 ? parseLabels(labels) : null,
      ),
    );
  });

sandbox
  .command('rebuild')
  .description(
    "Swap the container, keep /home/user — next use starts on the template's current image (or the base image)",
  )
  .argument('<name>', 'the sandbox name to rebuild')
  .action(async (name: string) => {
    console.log(await sandboxRebuild(clientFromEnv(process.env), name));
  });

sandbox
  .command('destroy')
  .description('Destroy the sandbox behind a name (idempotent)')
  .argument('<name>', 'the sandbox name to destroy')
  .action(async (name: string) => {
    console.log(await sandboxDestroy(clientFromEnv(process.env), name));
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

const apikey = program
  .command('apikey')
  .description(
    'Manage API keys — rotatable peers of DORMICE_API_TOKEN, revocable without a restart',
  );

apikey
  .command('create')
  .description('Mint an API key; the token is printed once and never again')
  .argument('<name>', 'a human handle for the key, e.g. ci or laptop')
  .option(
    '--expires <date>',
    'expiry date (YYYY-MM-DD, works through that day); omit for never',
  )
  .action(async (name: string, options: { expires?: string }) => {
    console.log(
      await apikeyCreate(clientFromEnv(process.env), name, options.expires),
    );
  });

apikey
  .command('ls')
  .description('List every API key ever minted, revoked ones included')
  .action(async () => {
    console.log(await apikeyLs(clientFromEnv(process.env)));
  });

apikey
  .command('disable')
  .description('Park an API key reversibly — it stops working until re-enabled')
  .argument('<name>', 'name of the key to disable')
  .action(async (name: string) => {
    console.log(await apikeyDisable(clientFromEnv(process.env), name));
  });

apikey
  .command('enable')
  .description('Resume a parked API key')
  .argument('<name>', 'name of the key to enable')
  .action(async (name: string) => {
    console.log(await apikeyEnable(clientFromEnv(process.env), name));
  });

apikey
  .command('revoke')
  .description(
    'Revoke the active API key under a name — it stops working on the next request',
  )
  .argument('<name>', 'name of the key to revoke')
  .action(async (name: string) => {
    console.log(await apikeyRevoke(clientFromEnv(process.env), name));
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
