# Dormice

**The SQLite of agent sandboxes** — a self-hosted sandbox platform for AI agents. One machine, sandboxes that live forever, idle costs nothing.

> **Status: early development.** The daemon, its lifecycle engine, the SDK, and the real Docker + gVisor executor work end to end — the full create → freeze → stop → wake cycle passes on real infrastructure. Running code inside a sandbox and the E2B-compatible API are the next milestones. Nothing here is ready for production yet.

## The idea

Cloud sandbox platforms charge for every second a sandbox exists, so their sandboxes are disposable. Dormice inverts that: you run it on a machine you already pay for, and sandboxes are **permanent** — they just get cheaper to keep the longer they sit idle.

- **`acquireSandbox(userKey)` is the entire mental model.** Idempotent: the same key always comes back to the same sandbox, whatever state it was in. No sandbox → create; frozen → wake; stopped → start; archived → restore.
- **Idle is free.** Sandboxes cool down on their own — `active → frozen → stopped → archived` — one rung at a time, and any acquire brings them back.
- **Deploys like a single binary.** One daemon, one SQLite ledger, one port. No Kubernetes, no external database.
- **E2B compatibility is on the roadmap**: the goal is that the official `e2b` SDK works against Dormice by changing two URLs.

## Repository layout

pnpm monorepo:

| Path | What it is |
| --- | --- |
| `packages/shared` | Protocol schemas (zod) — the single source of truth for wire types |
| `packages/server` | The daemon: Fastify + SQLite ledger + lifecycle engine |
| `packages/sdk` | `@dormice/sdk` — TypeScript client for the native API |
| `packages/cli` | `dormice` command-line tool (`dor` for short) |
| `packages/web` | Web console (skeleton) |
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
