---
'@dormice/cli': patch
---

`dor doctor`'s firewall-persistence check now believes only what it can verify: `systemctl is-enabled` must say exactly `enabled` (exit 0 alone also covers `enabled-runtime`, `static`, `alias` and `generated`, none of which re-add the rules at the next boot), the `dormice-metadata-firewall` unit file must still drop both metadata targets, and the unit's last run must have succeeded — each failure mode gets its own warning naming what broke. Hosts persisted the pre-unit way via `iptables-persistent` still pass. Alongside, install.sh's unit now waits for the xtables lock (`iptables -w 10`), so losing the boot-time lock race against dockerd can no longer silently drop the metadata firewall.
