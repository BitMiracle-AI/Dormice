# @dormice/sdk

TypeScript client for [Dormice](https://github.com/BitMiracle-AI/Dormice) — a self-hosted agent sandbox platform: one machine, sandboxes that live forever, idle costs nothing.

This is the native SDK. It talks to your own Dormice daemon over its RPC API; nothing here calls a hosted service.

## Install

```sh
npm install @dormice/sdk
```

## Quick start

```ts
import { Dormice } from '@dormice/sdk';

const client = new Dormice({
  endpoint: 'http://127.0.0.1:3676', // your daemon
  token: process.env.DORMICE_API_TOKEN!,
});

// acquire is idempotent: one key, one sandbox — created, woken or
// restored as needed. Call it as often as you like.
await client.acquireSandbox('my-agent');

const result = await client.execCommand('my-agent', 'echo hello');
console.log(result.stdout); // "hello\n"

await client.writeFiles('my-agent', [
  { path: 'notes.txt', content: 'kept on the sandbox disk' },
]);
const file = await client.readFile('my-agent', 'notes.txt');
console.log(new TextDecoder().decode(file.content));

await client.releaseSandbox('my-agent'); // destroy, idempotent
```

Idle sandboxes freeze (RAM squeezed out, ~50 ms wake), then stop (disk only);
`acquireSandbox` — or any command or file call — brings them back. The
lifecycle policy is set at creation: `freezeAfterSeconds`, `stopAfterSeconds`
(pass `null` for a resident agent that never cold-starts), `archiveAfterSeconds`.

## Methods

| Method | What it does |
| --- | --- |
| `acquireSandbox(userKey, policy?)` | Create or wake the sandbox behind a key (idempotent) |
| `listSandboxes()` | Every sandbox with its current lifecycle state |
| `execCommand(userKey, command, opts?)` | Run a shell command; buffered stdout/stderr and the real exit code |
| `writeFiles(userKey, files)` | Write files onto the sandbox disk (relative paths land under `/home/user`) |
| `readFile(userKey, path)` | Read a file back as bytes |
| `rebuildSandbox(userKey)` | Swap the container, keep `/home/user` — next use starts on the daemon's current base image |
| `releaseSandbox(userKey)` | Destroy the sandbox (idempotent) |

A non-zero exit code is a result, not an error. API failures throw
`DormiceApiError` carrying the HTTP status and the daemon's message.

## E2B compatibility

The daemon also speaks the E2B protocol: the official `e2b` package works
against it by changing two URLs. See the
[repository](https://github.com/BitMiracle-AI/Dormice) for details — this SDK
is the smaller, native alternative.

## License

Apache-2.0
