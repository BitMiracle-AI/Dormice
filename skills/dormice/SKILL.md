---
name: dormice
description: Operate Dormice self-hosted agent sandboxes — acquire a sandbox, run commands, move files, tune lifecycle policy — through the official E2B SDKs, the native HTTP API and SDK, or the dor CLI. Use when connecting to a Dormice server, running untrusted or AI-generated code in a sandbox, giving an agent a persistent workspace, or migrating an application off E2B.
---

# Dormice

Dormice is a self-hosted sandbox platform: one daemon on one machine, and
sandboxes that are **permanent** — idle ones cool down
(`active → frozen → stopped → archived`) instead of being destroyed, and any
acquire brings them back. Two facts drive every workflow below:

- **`acquireSandbox(externalId)` is the entire mental model.** Idempotent:
  the same key always returns the same sandbox, whatever state it was in.
  No sandbox → create; frozen → wake (~50 ms); stopped → start; archived →
  restore. Only `acquireSandbox` creates — other verbs answer 404 for an
  unknown key.
- **The disk, not the container, is the sandbox's body.** Files survive
  freezes, stops, daemon restarts, and host reboots. Only `destroySandbox`
  loses data.

## Connecting

The daemon serves everything on one port and binds to `127.0.0.1:3676`
only. On the server itself use that address directly; from another machine
the operator has either an SSH tunnel
(`ssh -L 3676:127.0.0.1:3676 root@host`, then use `http://127.0.0.1:3676`)
or a reverse-proxy domain (then use `https://their-domain`). Auth is one
API token (created by the installer, hex): ask the user for the endpoint
and token, conventionally held in `DORMICE_ENDPOINT` / `DORMICE_API_TOKEN`.

## Pick an entry path

| Path | When |
| --- | --- |
| Official `e2b` SDK (npm / PyPI, unmodified) | Default for application code today, and for anything already written against E2B |
| Native HTTP API (`curl`) | Shell scripts, quick checks, any language without an SDK |
| `@dormice/sdk` (TypeScript) | Native semantics with types; first npm release is queued — inside the repo, `pnpm build` produces it |
| `dor` CLI | Operator work in a terminal: list, exec, push/pull, rebuild, doctor |

## Official E2B SDKs — change two URLs

The daemon speaks the E2B protocol on `/e2b/api` (control plane) and
`/e2b/envd` (in-sandbox). Prefix the token with `e2b_`:

```ts
import { Sandbox } from 'e2b';

const sbx = await Sandbox.create({
  apiKey: `e2b_${process.env.DORMICE_API_TOKEN}`,
  apiUrl: 'http://127.0.0.1:3676/e2b/api',
  sandboxUrl: 'http://127.0.0.1:3676/e2b/envd',
});
await sbx.commands.run('echo hello');
```

```python
import os
from e2b import Sandbox

sandbox = Sandbox.create(
    api_key=f"e2b_{os.environ['DORMICE_API_TOKEN']}",
    api_url="http://127.0.0.1:3676/e2b/api",
    sandbox_url="http://127.0.0.1:3676/e2b/envd",
)
sandbox.commands.run("echo hello")
```

`Sandbox.create` makes a fresh sandbox each time (faithful E2B semantics).
To get Dormice's idempotent acquire through the E2B surface, pass
`metadata: { externalId: 'my-project' }` — the same key then always returns
the same sandbox with its files intact. E2B `timeoutMs` deadlines are real:
at the deadline the sandbox is killed, or parked with
`lifecycle: { onTimeout: 'pause' }` and revived by `connect`.

## Native API — one POST route per verb

Every operation is `POST /<sdkMethodName>` with a JSON body and
`Authorization: Bearer <token>`; every non-2xx body is
`{ "message": "..." }`. Core loop with the SDK:

```ts
import { Dormice } from '@dormice/sdk';

const client = new Dormice({
  endpoint: 'http://127.0.0.1:3676',
  token: process.env.DORMICE_API_TOKEN!,
});

await client.acquireSandbox('my-agent', { policy: { stopAfterSeconds: null } });

const result = await client.execCommand('my-agent', 'python3 -c "print(6 * 7)"');
console.log(result.exitCode, result.stdout); // 0 42

await client.writeFiles('my-agent', [
  { path: 'notes.txt', content: 'survives freeze and stop' },
]);

await client.destroySandbox('my-agent'); // the only verb that loses data
```

The same loop in curl:

```sh
curl -X POST http://127.0.0.1:3676/acquireSandbox \
  -H "Authorization: Bearer $DORMICE_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"externalId": "my-agent"}'
```

Verbs: `acquireSandbox`, `updatePolicy` (patch an existing sandbox's
lifecycle policy in place — no wake, no destroy), `listSandboxes`,
`execCommand`, `writeFiles` / `writeFile`, `readFile` / `readFiles`,
`rebuildSandbox` (fresh container, `/home/user` kept), `destroySandbox`,
`registerTemplate` / `listTemplates` / `removeTemplate`,
`getHostMetrics`, `getSandboxMetrics` / `listSandboxMetrics` (live
resource samples; never wake anything), `listSandboxImages` (who still
runs an old template image), `listActivity` (recent daemon history),
`getConfig` (effective config, secrets redacted), `getIngress` /
`setIngress` (bind domains on the daemon's managed reverse proxy).
`execCommand` takes
`{ externalId, command, timeoutSeconds?, cwd?, env? }` and returns
`{ exitCode, stdout, stderr, ... }` — **a non-zero exit code is a result,
not an HTTP error**. When a sandbox is coming back from S3, `acquireSandbox`
returns `{ status: 'restoring', progress }` immediately; poll it until the
status flips to `ready`.

## CLI

```sh
dor sandbox ls                        # every sandbox, with lifecycle state
dor sandbox exec my-agent 'uname -r'  # exit code passes through
dor sandbox push my-agent ./data.csv  # → /home/user/data.csv
dor sandbox pull my-agent notes.txt
dor sandbox rebuild my-agent          # fresh container, /home/user kept
dor sandbox destroy my-agent
dor doctor                            # can this machine run sandboxes?
```

Connects via `DORMICE_ENDPOINT` and `DORMICE_API_TOKEN`.

## Files

Native file verbs move content as base64 inside JSON, capped at 16 MiB per
file (batches 48 MiB) with honest refusals — never a truncated file. Paths
are absolute or relative to `/home/user`; parent directories are created.
Past the cap: download from *inside* the sandbox (`execCommand` with `curl`,
in the stock image), or use the E2B files surface (`files.read/write`
stream uncapped; `uploadUrl()` / `downloadUrl()` mint signed URLs).

## Lifecycle policy — three knobs

Set at creation (overrides while acquiring an existing sandbox are not
applied — change an existing sandbox's policy with `updatePolicy`, a
patch that never wakes and never resets the idle clock); all count
seconds since last activity, ordering freeze ≤ stop ≤ archive:

| Knob | Default | `null` means |
| --- | --- | --- |
| `freezeAfterSeconds` | 10 minutes | — (freezing is always on) |
| `stopAfterSeconds` | 3 days | never stop |
| `archiveAfterSeconds` | 7 days when S3 is configured, else never | never archive |

The pattern Dormice was built for — one permanent sandbox per agent:

```ts
await client.acquireSandbox(`agent-${userId}`, {
  policy: { stopAfterSeconds: null },
});
```

It parks at frozen (~5 MiB resident) and wakes in ~50 ms — never a cold
start; frozen processes suspend mid-flight and resume exactly where they
were. Commands and file operations reset the idle clock; observation
(`listSandboxes`, metrics) never wakes or warms anything. A background
process does **not** keep its sandbox warm — a resident sandbox means
"ready whenever the agent returns", not an unattended 24×7 workload.

## Gotchas

- **Keep the API token hexadecimal.** The Python E2B SDK validates
  `e2b_[0-9a-f]+` client-side; other characters fail before any request.
- **Bring a patient HTTP client.** `execCommand` sends response headers
  only when the command finishes — legally hours later. Node's undici ships
  a hidden ~5-minute header timeout; disable it (the native SDK already
  does) or long commands die at exactly 300 s with an error that looks like
  the server's fault.
- **Sandboxes run untrusted code, contained.** Everything runs as a
  non-root user (uid 1000) inside gVisor. The stock image ships Ubuntu
  24.04, Python 3.12, Node 24, git, ripgrep, and a pinned Claude Code.

## Learn more

Docs (served as `/llms.txt`, `/llms-full.txt`, and per-page `.md` on the
project site; sources on GitHub):
[quickstart](https://github.com/BitMiracle-AI/Dormice/blob/main/website/content/docs/quickstart.mdx) ·
[lifecycle](https://github.com/BitMiracle-AI/Dormice/blob/main/website/content/docs/lifecycle.mdx) ·
[E2B SDKs](https://github.com/BitMiracle-AI/Dormice/blob/main/website/content/docs/e2b-sdks.mdx) ·
[HTTP API](https://github.com/BitMiracle-AI/Dormice/blob/main/website/content/docs/http-api.mdx) ·
[files](https://github.com/BitMiracle-AI/Dormice/blob/main/website/content/docs/files.mdx) ·
[resident agents](https://github.com/BitMiracle-AI/Dormice/blob/main/website/content/docs/resident-agents.mdx)
