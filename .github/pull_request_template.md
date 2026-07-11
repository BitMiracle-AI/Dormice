## What & why

<!-- What changed, and the reasoning. Link the issue if one exists. -->

## Checklist

- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm test` passes locally (build first — the e2e suite runs the built daemon)
- [ ] Behavior changes come with tests that fail without the change
- [ ] User-facing changes to `@dormice/shared` / `sdk` / `cli` have a changeset (`pnpm changeset`)
- [ ] README updated if this changes documented behavior
