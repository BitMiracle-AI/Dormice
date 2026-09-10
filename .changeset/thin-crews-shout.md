---
"@dormice/sdk": patch
---

Fix `updateApiKey` so a patch object can no longer override the target id. Before this, `{ id, ...patch }` let an `id` field inside `patch` win over the id you pass as the first argument, so the request could edit the wrong key.
