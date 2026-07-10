# @dormice/shared

Protocol schemas ([zod](https://zod.dev)) and types shared by the
[Dormice](https://github.com/BitMiracle-AI/Dormice) daemon, SDK and web
console: sandbox lifecycle states, the three-knob lifecycle policy,
request/response shapes, and the sandbox path resolver.

You probably want [`@dormice/sdk`](https://www.npmjs.com/package/@dormice/sdk)
instead — it depends on this package and re-exports what applications need.
This one exists so the server, the SDK and the browser console all validate
against a single source of truth.

## License

Apache-2.0
