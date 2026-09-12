---
"@dormice/server": patch
---

Directory watches (`WatchDir` and the polling `CreateWatcher`) now read and validate the `user` option the SDKs send over Basic auth, the same way every other filesystem verb already does. Before this, the authorization header was ignored and every watch ran as the default user, so `watchDir(..., { user: 'root' })` against a root-only tree failed, and an unsupported username was accepted instead of being rejected like it is for `Stat`, `ListDir`, and the rest.
