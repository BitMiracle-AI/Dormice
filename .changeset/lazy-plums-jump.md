---
"@dormice/cli": patch
---

`dor sandbox exec -t <seconds>` now validates the timeout value where the flag is known, so a typo (`-t 10m`) is reported as `--timeout must be a positive integer of seconds, got "10m"` instead of failing later with an unrelated `AbortSignal.timeout(NaN)` error that never mentions the flag.
