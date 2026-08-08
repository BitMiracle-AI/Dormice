# @dormice/cli

## 0.2.0

### Patch Changes

- d8a355a: `dor doctor`'s sysctl checks now verify both orders that can replay the boot config: systemd-sysctl's boot order, and procps `sysctl --system`, which applies `/etc/sysctl.conf` last — even without the 99-sysctl.conf symlink. The `--cat-config` parser no longer mistakes comments that merely start with `# /` for file markers (the stock sysctl.conf header is one, so a warning could blame a comment instead of the real file), recognizes the `- key = value` ignore-error form, tolerates CRLF line endings, and probes /lib/systemd like install.sh does; an unreadable boot config is a warn now, not a silent pass — that hazard is exactly the one the live value cannot expose. `vm.swappiness` gains the same boot-order coverage: 100 now with a boot config saying otherwise warns naming the file.
- 080c24a: `dor doctor` gains a `net.ipv4.ip_forward` check: fail when forwarding is off (sandboxes have no network right now), warn when it is on but the boot config would turn it off at the next sysctl replay — naming the offending file. The firewall-persistence check now recognizes the `dormice-metadata-firewall` systemd unit that install.sh writes instead of `iptables-persistent` (hosts persisted the old way still pass), and the swappiness fix no longer suggests `sysctl --system`, which replays unrelated operator settings.
- 0f388d0: `dor doctor`'s firewall-persistence check now believes only what it can verify: `systemctl is-enabled` must say exactly `enabled` (exit 0 alone also covers `enabled-runtime`, `static`, `alias` and `generated`, none of which re-add the rules at the next boot), the `dormice-metadata-firewall` unit file must still drop both metadata targets, and the unit's last run must have succeeded — each failure mode gets its own warning naming what broke. Hosts persisted the pre-unit way via `iptables-persistent` still pass. Alongside, install.sh's unit now waits for the xtables lock (`iptables -w 10`), so losing the boot-time lock race against dockerd can no longer silently drop the metadata firewall.
- Updated dependencies [bc668ce]
  - @dormice/sdk@0.2.0

## 0.1.0

### Minor Changes

- First public release. The native TypeScript SDK (acquire/list/release/rebuild,
  exec, file in/out), the `dormice`/`dor` CLI (host doctor plus the sandbox
  verbs), and the shared protocol schemas they are built on.

### Patch Changes

- Updated dependencies
  - @dormice/sdk@0.1.0
