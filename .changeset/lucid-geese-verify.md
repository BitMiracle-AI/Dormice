---
'@dormice/cli': patch
---

`dor doctor`'s sysctl checks now verify both orders that can replay the boot config: systemd-sysctl's boot order, and procps `sysctl --system`, which applies `/etc/sysctl.conf` last — even without the 99-sysctl.conf symlink. The `--cat-config` parser no longer mistakes comments that merely start with `# /` for file markers (the stock sysctl.conf header is one, so a warning could blame a comment instead of the real file), recognizes the `- key = value` ignore-error form, tolerates CRLF line endings, and probes /lib/systemd like install.sh does; an unreadable boot config is a warn now, not a silent pass — that hazard is exactly the one the live value cannot expose. `vm.swappiness` gains the same boot-order coverage: 100 now with a boot config saying otherwise warns naming the file.
