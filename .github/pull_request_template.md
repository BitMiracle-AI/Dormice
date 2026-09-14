<!--
Dormice does not accept pull requests from outside the maintaining team.
Please read CONTRIBUTING.md before opening one. If you found a bug or have
a fix in mind, open an issue instead: a maintainer will implement it, test
it on a real host, and credit you.

Pull requests opened without that context will be closed with a pointer
to CONTRIBUTING.md.
-->

## What & why

<!-- What changed, and the reasoning. Link the issue if one exists. -->

## Checklist

- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm test` passes locally (build first — the e2e suite runs the built daemon)
- [ ] Behavior changes come with tests that fail without the change
- [ ] User-facing changes to `@dormice/shared` / `sdk` / `cli` have a changeset (`pnpm changeset`)
- [ ] README updated if this changes documented behavior
