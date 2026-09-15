---
"@dormice/shared": minor
"@dormice/sdk": minor
"@dormice/cli": minor
---

The fleet installs and upgrades as one. The base image is a fleet setting (`settings.baseImage`, seeded from the gateway's `DORMICE_BASE_IMAGE`, edited with `updateSettings { baseImage }`) beside a read-only `registryAddress`; both ride the configuration bundle to every node, and a node pulls an image it lacks from the fleet registry. The upgrade verbs answer at the gateway: `applyUpgrade` upgrades the gateway's machine and then every node behind it, told one at a time at its check-in; `applyUpgrade { nodeId }` tells a stuck node again; `getUpgradeStatus.nodes[]` lists each node's standing. The check-in carries `selfUpgrade` and can answer `upgrade: true`. `dor doctor` reads the fleet's base image from the environment the installer gives it and checks the fleet registry is reachable over TLS.
