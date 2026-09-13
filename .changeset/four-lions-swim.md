---
"@dormice/server": patch
---

`importDisk`'s read of the archive file now forwards a source read failure (host EIO, or the file removed between the caller's own stat and the read) into the same catch that tears down the half-provisioned disk. Before this, `pipe()` did not carry the source stream's error to its destination, so the failure became an unlistened `'error'` event and crashed the daemon instead of being handled.
