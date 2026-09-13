---
"@dormice/shared": minor
---

Wire schemas for a fleet behind a gateway: `lookupSandbox` (a node answers "do you hold this sandbox?" by name or id), the node check-in (`checkInRequestSchema`, readings, build), and the gateway's `listNodes` / `removeNode`. The host-metrics schema is split into named parts (`hostReadingSchema`, `dataDiskSchema`, `sandboxStateCountsSchema`) that `hostMetricsResponseSchema` still composes unchanged.
