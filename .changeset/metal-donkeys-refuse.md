---
'@dormice/cli': patch
---

`dor doctor` gains a `net.ipv4.ip_forward` check: fail when forwarding is off (sandboxes have no network right now), warn when it is on but the boot config would turn it off at the next sysctl replay — naming the offending file. The firewall-persistence check now recognizes the `dormice-metadata-firewall` systemd unit that install.sh writes instead of `iptables-persistent` (hosts persisted the old way still pass), and the swappiness fix no longer suggests `sysctl --system`, which replays unrelated operator settings.
