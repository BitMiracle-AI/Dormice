# Contributing to Dormice

Thanks for your interest! Dormice is in early development and moving
fast — before building something large, please open an issue first so
we can agree on the direction and nobody's work is wasted.

## Development setup

Requirements: Node.js >= 22 and pnpm. The exact pnpm version is pinned
in `package.json`'s `packageManager` field, so `corepack enable` gives
you the right one automatically.

```sh
pnpm install
pnpm build      # build first: the e2e suite boots the *built* daemon
pnpm typecheck
pnpm lint
pnpm test
```

That chain, in that order, is exactly what CI runs — if it is green
locally, CI will agree. **`pnpm build` must come before `pnpm test`**:
the black-box e2e suite spawns `dist/main.js`, and a stale or missing
build fails honestly rather than testing yesterday's code.

Everything above runs on any OS. By default the daemon uses an
in-memory fake executor, so no Docker, no Linux, and no root are needed
for development.

### Real-sandbox tests (mostly a maintainer concern)

The Docker + gVisor executor is verified by a contract suite — the same
exam the fake executor takes, run against real containers. It needs a
Linux host with root, gVisor (`runsc`) installed, and a base image
built, and is skipped automatically everywhere else, including CI:

```sh
DORMICE_DOCKER_CONTRACT=1 DORMICE_BASE_IMAGE=<image> pnpm --filter @dormice/server test
```

You do not need this for most changes — a PR that passes the normal
chain is reviewable, and real-hardware verification happens before
release.

## Code style

- Formatting and linting are Biome's job (`pnpm format`, `pnpm lint`) —
  single quotes, 2-space indent, no debates.
- Comments explain constraints the code cannot express — the why, not
  the what.
- Prefer one place that decides a thing over defensive re-checks
  scattered everywhere, and an honest, named error over a silent
  fallback.

## Tests

Every behavior change comes with a test that fails without the change.
The style here is black-box where possible: the e2e suite drives a real
daemon process over HTTP, and both executors must pass one shared
contract with identical error messages.

## Commits and pull requests

- Commit messages in English: a short first line saying what changed,
  **no type prefixes** (`feat:`, `fix:`), reasoning in the body when a
  decision is worth recording.
- Keep PRs small and focused, and run the full verification chain
  before opening one.
- If your change affects users of the published packages
  (`@dormice/shared`, `@dormice/sdk`, `@dormice/cli`), add a changeset:
  `pnpm changeset`.

## Security issues

Never in a public issue or PR — see [SECURITY.md](SECURITY.md).
