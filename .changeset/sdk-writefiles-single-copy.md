---
'@dormice/sdk': patch
---

Skip a redundant full-content copy in `writeFiles` / `writeFile`: `Buffer.from` already accepts `string | Uint8Array` and UTF-8-encodes strings natively, so the `TextEncoder.encode` + `Buffer.from` chain was one extra allocation and memcpy per string file on the push hot path. Base64 output is byte-identical.
