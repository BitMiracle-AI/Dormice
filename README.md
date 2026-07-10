# Dormice

**The SQLite of agent sandboxes** — a self-hosted sandbox platform for AI agents. One machine, sandboxes that live forever, idle costs nothing.

> **Status: early development.** The daemon, its lifecycle engine, the SDK, the CLI, the web console, the real Docker + gVisor executor, and the E2B-compatible API work end to end — the full create → freeze → stop → wake cycle, command execution, file I/O, and the official `e2b` SDK against real infrastructure. Nothing here is ready for production yet.

## The idea

Cloud sandbox platforms charge for every second a sandbox exists, so their sandboxes are disposable. Dormice inverts that: you run it on a machine you already pay for, and sandboxes are **permanent** — they just get cheaper to keep the longer they sit idle.

- **`acquireSandbox(userKey)` is the entire mental model.** Idempotent: the same key always comes back to the same sandbox, whatever state it was in. No sandbox → create; frozen → wake; stopped → start; archived → restore.
- **Idle is free.** Sandboxes cool down on their own — `active → frozen → stopped → archived` — one rung at a time, and any acquire brings them back. Measured on real hardware: freezing takes an idle sandbox holding 1 GiB down to ~5 MiB of resident memory, and waking it takes ~50 ms.
- **Deploys like a single binary.** One daemon, one SQLite ledger, one port. No Kubernetes, no external database.
- **[E2B compatible](#e2b-compatibility)**: the official `e2b` SDK works against Dormice by changing two URLs.

## Install

One command on a bare Ubuntu/Debian x86_64 host (as root):

```sh
curl -fsSL https://raw.githubusercontent.com/BitMiracle-AI/Dormice/main/deploy/install.sh | bash
```

Behind a slow connection to the usual sources, add `-s -- --mirror cn`.
The installer is idempotent — re-running it upgrades the code and repairs
drift, and never rotates your API token. It ends by running `dor doctor`,
a battery of read-only checks — three of them boot a real gVisor
container — that decides whether the install actually succeeded;
`dor doctor` can be re-run on its own at any time.

## Quick start

`@dormice/sdk` is the native TypeScript client. (Not on npm yet — the
first release is queued; inside this repo, `pnpm build` produces it.)

```ts
import { Dormice } from '@dormice/sdk';

const client = new Dormice({
  endpoint: 'http://127.0.0.1:3676',
  token: process.env.DORMICE_API_TOKEN!,
});

// One key, one sandbox — created, woken or restarted as needed.
// stopAfterSeconds: null makes it a resident agent: it may freeze when
// idle (~50 ms to wake) but never cold-starts.
await client.acquireSandbox('my-agent', { stopAfterSeconds: null });

const result = await client.execCommand('my-agent', 'python3 -c "print(6 * 7)"');
console.log(result.exitCode, result.stdout); // 0 42

await client.writeFiles('my-agent', [
  { path: 'notes.txt', content: 'survives freeze and stop' },
]);

await client.releaseSandbox('my-agent'); // destroy — the only verb that loses data
```

The wire is plain HTTP RPC (`POST /acquireSandbox`, `POST /execCommand`, …),
so `curl` works where the SDK doesn't reach, and the `dor` CLI covers the
operator side: `dor sandbox ls / exec / push / pull / rebuild / release`,
plus `dor doctor`. The full native surface is documented in
[`packages/sdk`](packages/sdk/README.md).

## E2B compatibility

The daemon speaks the E2B protocol on two prefixes (`/e2b/api`,
`/e2b/envd`). The **official `e2b` package** — unmodified, straight from
npm — runs against Dormice with two URLs and an API-key prefix; migrating
an application is configuration, not code:

```ts
import { Sandbox } from 'e2b';

const sbx = await Sandbox.create({
  apiKey: `e2b_${process.env.DORMICE_API_TOKEN}`,
  apiUrl: 'http://127.0.0.1:3676/e2b/api',
  sandboxUrl: 'http://127.0.0.1:3676/e2b/envd',
});
```

Everything below is exercised by the black-box e2e suite *through the
official package*, and has passed against a real Docker + gVisor daemon:

| Surface | Notes |
| --- | --- |
| `Sandbox.create` / `connect` / `kill` / `list` | `list` filters by state and metadata, and paginates |
| Timeouts | `timeoutMs` and `setTimeout()` are real absolute deadlines; `lifecycle: { onTimeout: 'pause' }` parks the sandbox instead of killing it |
| `pause()` / resume | explicit pause; `connect` revives it, files intact |
| `commands.run` | live streaming (`onStdout` / `onStderr`), background + `connect` / `disconnect`, `sendStdin`, `kill`, `list`, per-command `envs`, `user: 'root'`; a non-zero exit raises the SDK's own `CommandExitError` |
| `pty.*` | `create` / `sendInput` / `resize` / `kill` — a real interactive bash |
| `files` read / write | text or bytes, streamed, no artificial size cap — the disk quota is the cap |
| `uploadUrl()` / `downloadUrl()` | signed URLs: expiry enforced, a tampered signature is a 401 |
| `files.list` / `exists` / `makeDir` / `rename` / `remove` | typed errors match the SDK's expectations |
| `files.watchDir` | streamed events, and the polling watcher API the Python sync SDK uses |
| `getHost(port)` | port proxy with wake-on-traffic (set `DORMICE_SANDBOX_DOMAIN`) |
| `getMetrics()` | one live sample; observing never wakes a frozen sandbox |

Deliberate deltas from the hosted product:

- **No template builds.** Every sandbox runs the daemon's single base
  image (`DORMICE_BASE_IMAGE`); the `template` argument is accepted and
  ignored.
- **Freezing keeps processes.** A frozen sandbox's processes suspend and
  resume mid-flight — any touch wakes the sandbox in ~50 ms.
- **Permanence stays the default.** Sandboxes created through the E2B
  surface get real deadlines, as E2B semantics demand; deadlines are never
  imposed on natively created sandboxes.
- **`metadata.userKey`** turns `Sandbox.create` into Dormice's idempotent
  acquire: the same key returns the same sandbox instead of a new one.
- **Not implemented**, answered with an honest `unimplemented` on the
  wire: `Process/StreamInput` (the JS SDK never calls it) and xattr-based
  file metadata. The daemon reports envd `0.6.1`, so the SDK itself gates
  those features client-side.

## Web console

The daemon serves a small web console at `http://127.0.0.1:3676/console` —
sign in with the API token once and it becomes an httpOnly session cookie;
the token itself is never stored anywhere the page can read. The console
shows every sandbox with its live lifecycle state (the same
`/listSandboxes` the SDK sees), opens a per-sandbox detail view, creates
sandboxes (the same idempotent `acquire`, with the lifecycle knobs),
releases them, and has a Connect page with copy-paste snippets for every
client (E2B SDK, native SDK, CLI) pointed at your own endpoint.

The daemon listens on 127.0.0.1 only, so reaching it from another machine
is a choice you make explicitly, one of two ways:

- **SSH tunnel** (private, zero setup):
  `ssh -L 3676:127.0.0.1:3676 root@host`, then open
  `http://127.0.0.1:3676/console`.
- **Reverse proxy** for the console, the API, and the E2B surface at once —
  e.g. Caddy, which also handles TLS certificates automatically once you
  give it a domain:

  ```
  your-domain.example {
  	reverse_proxy 127.0.0.1:3676 {
  		flush_interval -1
  	}
  }
  ```

  `flush_interval -1` matters: streamed command output is written frame by
  frame, and a buffering proxy would turn it into one lump at the end.
  Anything exposed beyond localhost should be HTTPS — the API token and the
  session cookie travel in every request.

## Host prerequisites (docker executor)

The daemon itself runs anywhere Node 22+ runs, with an in-memory fake
executor for development. Running **real** sandboxes needs a Linux host
prepared as above — `install.sh` automates all of it and `dor doctor`
verifies it, but these are the facts underneath:

- **Docker + gVisor (`runsc`)**, and root (loop mounts, cgroup writes).
- **Swap, and `vm.swappiness=100`.** Freezing squeezes an idle sandbox's
  memory out to swap; gVisor holds sandbox memory as shared memory, which
  the kernel refuses to swap at the default swappiness — measured on real
  hardware: 0 bytes reclaimed at the default, 99.5% reclaimed at 100. Note
  that some cloud images (Alibaba Cloud, for one) ship `vm.swappiness=0`;
  check the *effective* value with `sysctl vm.swappiness`, not the config
  files.
- **Network hardening is not optional.** Sandboxes run untrusted code:
  block the cloud metadata service from containers
  (`iptables -I DOCKER-USER -d 169.254.0.0/16 -j DROP`, persisted) and
  disable inter-container traffic (`"icc": false` in `daemon.json`). The
  daemon binds to 127.0.0.1 only, by design without a knob; exposing it is
  a reverse proxy's job.
- **One machine, one daemon.** The daemon enforces this with a lock next to
  its ledger and refuses to start when its ledger and the machine's reality
  cannot belong together.

## When Dormice is the wrong tool

Pick something else if:

- **You need a fleet.** One machine, one daemon, by design — that is where
  the simplicity comes from. Multi-machine sharding is a future direction
  (the schema already carries the fields), not a current feature.
- **You want a managed service.** No hosted anything, no SLA. That is
  E2B's product, and it is good at it.
- **Your threat model demands hardware virtualization.** Sandboxes are
  Docker + gVisor — a userspace kernel, chosen deliberately: freezing
  requires sandboxes to be processes, and "installs anywhere" rules out
  requiring KVM. If only Firecracker-class VM isolation will do, this
  trade is not for you.
- **You need cold archive today.** The `archived` state exists in the
  protocol, but the S3 archiver is not built yet; the knob defaults to off
  and nothing pretends otherwise.
- **Your workloads aren't Linux.** Sandboxes are Linux containers.

## Repository layout

pnpm monorepo:

| Path | What it is |
| --- | --- |
| `packages/shared` | Protocol schemas (zod) — the single source of truth for wire types |
| `packages/server` | The daemon: Fastify + SQLite ledger + lifecycle engine |
| `packages/sdk` | `@dormice/sdk` — TypeScript client for the native API |
| `packages/cli` | `dormice` command-line tool (`dor` for short) |
| `packages/console` | Web console: React SPA, served by the daemon at `/console` |
| `e2e` | Black-box suite: boots the built daemon, drives it over the wire |

## Development

```sh
pnpm install
pnpm build      # the e2e suite boots the built daemon, so build comes first
pnpm typecheck
pnpm lint
pnpm test
```

## License

[Apache-2.0](LICENSE)

## Trademark notice

E2B is a trademark of its respective owner. Dormice is an independent project and is not affiliated with, endorsed by, or sponsored by E2B. References to the `e2b` package describe interoperability with its published API only.
