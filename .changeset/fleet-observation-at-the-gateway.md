---
"@dormice/shared": minor
"@dormice/sdk": minor
"@dormice/cli": minor
---

The fleet-wide observation verbs answer at the gateway and say what they could not see. `listSandboxes`, `listSandboxMetrics` and `listSandboxImages` carry an optional `silent` array — the nodes the gateway could not include, with why — and the SDK's three methods now return the whole response instead of the bare array (`.sandboxes`, `.samples`, `.images`). `getHostMetrics` and `getHostMetricsHistory` take an optional `nodeId`: a machine's reading names its machine, the fleet's sums are the new `getFleetMetrics`. `getFleetTimeline` is `getFleetStateHistory` (a count per state per moment is a state sample, not a snapshot). `dor sandbox ls` warns under the table when a node did not answer.
