---
"@dormice/cli": patch
---

`dor apikey disable`, `enable` and `revoke` now trim the name argument before matching, the same way key creation trims a name before storing it. Before this, a name typed with the exact leading/trailing whitespace used at creation time (or any other spelling that only differs by whitespace) failed to resolve, so a script or operator could not disable or revoke a credential.
