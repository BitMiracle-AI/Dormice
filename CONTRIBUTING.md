# Contributing to Dormice

Dormice runs production sandbox fleets for several commercial services. Every
line in this repository is reviewed by the core team and verified on real
hosts before it ships, and the people who carry that responsibility are the
people who write the code.

For that reason **Dormice does not accept code contributions (pull requests)
from outside the maintaining team.** This is a deliberate choice about how the
project is run, not a judgement of any individual patch. Pull requests opened
against this repository will be closed with a pointer to this document.

## What we do welcome

**Issues.** Bug reports, reproductions, design objections and feature requests
are the most valuable thing you can give this project. Many fixes here started
as an outside report. When you file one:

- Say what you ran, what you expected, and what happened. A reproduction
  against a fresh install is worth more than a diagnosis.
- If you have already found the cause, describe it in the issue. If you have a
  fix in mind, describe the approach in words or a short snippet. A maintainer
  will implement it, test it on a real host, and credit you in the commit and
  the issue.
- Security problems never go in a public issue — see [SECURITY.md](SECURITY.md).

**Forks.** Dormice is Apache-2.0. If you need a change we have not made, fork
and carry it. If your fork proves something out, tell us about it in an issue.

## Why not "just review the PR"?

Because review is the expensive part, not typing. A change to a sandbox
platform has to be reasoned about against the ledger, the container runtime,
the archive path and the compatibility surface, then exercised on a host that
looks like production. Doing that for code we did not write costs more than
writing it ourselves from a clear report, and leaves us less certain about the
result. We would rather spend that time on your issue.

---

The rest of this document is for the maintaining team and for anyone running
a fork.

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

### Real-sandbox tests

The Docker + gVisor executor is verified by a contract suite — the same
exam the fake executor takes, run against real containers. It needs a
Linux host with root, gVisor (`runsc`) installed, and a base image
built, and is skipped automatically everywhere else, including CI:

```sh
DORMICE_DOCKER_CONTRACT=1 DORMICE_BASE_IMAGE=<image> pnpm --filter @dormice/server test
```

Real-hardware verification happens before every release.

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

## Commits

- Commit messages in English: a short first line saying what changed,
  **no type prefixes** (`feat:`, `fix:`), reasoning in the body when a
  decision is worth recording.
- Keep changes small and focused, and run the full verification chain
  before pushing.
- If a change affects users of the published packages
  (`@dormice/shared`, `@dormice/sdk`, `@dormice/cli`), add a changeset:
  `pnpm changeset`.
