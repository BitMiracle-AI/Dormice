// The whole native surface in one pass: acquire → exec → files → release.
//
// From the repository root, against a daemon installed with install.sh:
//   pnpm install && pnpm build
//   DORMICE_API_TOKEN=... node examples/native-lifecycle.mjs
import { Dormice } from '@dormice/sdk';

const endpoint = process.env.DORMICE_ENDPOINT ?? 'http://127.0.0.1:3676';
const token = process.env.DORMICE_API_TOKEN;
if (!token) {
  console.error(
    'Set DORMICE_API_TOKEN (it is in /etc/dormice/env on an install.sh host).',
  );
  process.exit(1);
}

const client = new Dormice({ endpoint, token });
const key = 'example-lifecycle';

// acquire() is the single entry point, idempotent on a key you choose:
// no sandbox → create, frozen → wake, stopped → restart, archived → restore.
const { sandbox } = await client.acquireSandbox(key);
console.log(`acquired ${sandbox.sandboxId} (${sandbox.state})`);

// Real code execution. `uname -r` names gVisor's userspace kernel — proof
// the command did not run on your host.
const result = await client.execCommand(
  key,
  'python3 -c "print(6 * 7)" && uname -r',
);
console.log(result.stdout.trimEnd());

// A nonzero exit is a result, not an exception.
const failed = await client.execCommand(key, 'exit 3');
console.log(`'exit 3' exited with ${failed.exitCode}`);

// Files go in and out; relative paths resolve against /home/user.
await client.writeFiles(key, [
  { path: 'hello.txt', content: 'written through the SDK\n' },
]);
const file = await client.readFile(key, 'hello.txt');
console.log(`read back: ${new TextDecoder().decode(file.content).trimEnd()}`);

// The same key always answers with the same sandbox.
const again = await client.acquireSandbox(key);
console.log(
  `same sandbox on re-acquire: ${again.sandbox.sandboxId === sandbox.sandboxId}`,
);

// release() destroys container and disk — the only verb that loses data.
await client.destroySandbox(key);
console.log('destroyed');
