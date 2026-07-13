# Examples

Small, runnable programs against a live Dormice daemon. Each file is
self-contained — read it top to bottom, then run it.

| File | What it shows |
| --- | --- |
| [`native-lifecycle.mjs`](native-lifecycle.mjs) | The native SDK end to end: idempotent `acquireSandbox`, command execution, file I/O, `destroySandbox` |
| [`e2b-compat.mjs`](e2b-compat.mjs) | The **official `e2b` package**, unmodified, pointed at Dormice by two URLs — with live output streaming |
| [`resident-agent.mjs`](resident-agent.mjs) | A permanent per-agent sandbox (`stopAfterSeconds: null`): run it repeatedly, its state survives |

## Prerequisites

A running daemon with the docker executor — a host prepared by
[`install.sh`](../deploy/install.sh) is exactly right. The examples speak to
it through the same two environment variables the `dor` CLI uses:

```sh
export DORMICE_ENDPOINT=http://127.0.0.1:3676   # the default; omit when local
export DORMICE_API_TOKEN=...                    # /etc/dormice/env on the host
```

The daemon binds to 127.0.0.1 only. To run the examples from your laptop
against a remote host, open a tunnel first and keep the default endpoint:

```sh
ssh -L 3676:127.0.0.1:3676 root@your-host
```

## Running

From the repository root (`@dormice/sdk` is not on npm yet, so the examples
link against the local build):

```sh
pnpm install
pnpm build
node examples/native-lifecycle.mjs
node examples/e2b-compat.mjs
node examples/resident-agent.mjs   # leaves its sandbox behind — that is the point
```

In your own project, once the packages are published, the same code runs
after `npm install @dormice/sdk e2b`.

`resident-agent.mjs` deliberately leaves its sandbox running; when you are
done playing, remove it with `dor sandbox release example-resident-agent`
(or `destroySandbox` from the SDK).
