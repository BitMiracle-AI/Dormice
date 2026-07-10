# Dormice

**The SQLite of agent sandboxes** — a self-hosted sandbox platform for AI agents. One machine, sandboxes that live forever, idle costs nothing.

> **Status: early development.** The daemon, its lifecycle engine, the SDK, the CLI, the web console, the real Docker + gVisor executor, and the E2B-compatible API work end to end — the full create → freeze → stop → wake cycle, command execution, file I/O, and the official `e2b` SDK against real infrastructure. Nothing here is ready for production yet.

## The idea

Cloud sandbox platforms charge for every second a sandbox exists, so their sandboxes are disposable. Dormice inverts that: you run it on a machine you already pay for, and sandboxes are **permanent** — they just get cheaper to keep the longer they sit idle.

- **`acquireSandbox(userKey)` is the entire mental model.** Idempotent: the same key always comes back to the same sandbox, whatever state it was in. No sandbox → create; frozen → wake; stopped → start; archived → restore.
- **Idle is free.** Sandboxes cool down on their own — `active → frozen → stopped → archived` — one rung at a time, and any acquire brings them back.
- **Deploys like a single binary.** One daemon, one SQLite ledger, one port. No Kubernetes, no external database.
- **E2B compatible**: the official `e2b` SDK works against Dormice by changing two URLs (`apiUrl`, `sandboxUrl`).

## Install

One command on a bare Ubuntu/Debian x86_64 host (as root):

```sh
curl -fsSL https://raw.githubusercontent.com/BitMiracle-AI/Dormice/main/deploy/install.sh | bash
```

Behind a slow connection to the usual sources, add `-s -- --mirror cn`.
The installer is idempotent — re-running it upgrades the code and repairs
drift, and never rotates your API token. It ends by running `dor doctor`,
19 read-only checks (including three that boot a real gVisor container)
that decide whether the install actually succeeded; `dor doctor` can be
re-run on its own at any time.

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
