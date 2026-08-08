# @dormice/shared

## 0.2.0

### Minor Changes

- bc668ce: New verb `updateTemplate(name, template)` re-homes an existing sandbox onto another template — the update verb acquire deliberately is not. Without it, sandboxes created before a template rename reference the old name forever, and the old template can never be removed (removeTemplate refuses while referenced). `null` detaches back to the daemon's base image. A pure ledger write: nothing is woken and the idle clock is not refreshed; the new template's image is realized at the sandbox's next cold wake through the existing stale-shell convergence, disk untouched. Unknown template: 400. Unknown key: 404. A same-template update is a no-op that writes no history; changes are recorded as `template-changed` activity events.

## 0.1.0

### Minor Changes

- First public release. The native TypeScript SDK (acquire/list/release/rebuild,
  exec, file in/out), the `dormice`/`dor` CLI (host doctor plus the sandbox
  verbs), and the shared protocol schemas they are built on.
