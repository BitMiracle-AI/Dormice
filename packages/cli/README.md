# @dormice/cli

Command-line tool for [Dormice](https://github.com/BitMiracle-AI/Dormice)
daemons. Installs two names for the same binary: `dormice`, and `dor` for
people who type it all day.

## Install

```sh
npm install -g @dormice/cli
```

## Connect

Everything under `dor sandbox` talks to a daemon named by two environment
variables (it complains by name if one is missing):

```sh
export DORMICE_ENDPOINT=http://127.0.0.1:3676
export DORMICE_API_TOKEN=...
```

## Commands

| Command | What it does |
| --- | --- |
| `dor doctor [--quick]` | Read-only host check: can this machine run the daemon? (Linux, Docker, gVisor, swap, …) |
| `dor sandbox ls` | List every sandbox and its lifecycle state |
| `dor sandbox exec <key> <cmd> [-t seconds]` | Run a command inside a sandbox (wakes it first); its exit code passes through |
| `dor sandbox push <key> <local> [remote]` | Copy a local file into the sandbox |
| `dor sandbox pull <key> <remote> [local]` | Copy a file out; no local path = raw bytes to stdout |
| `dor sandbox rebuild <key>` | Swap the container, keep `/home/user` — next use starts on the daemon's current base image |
| `dor sandbox release <key>` | Destroy the sandbox (idempotent) |

`doctor` inspects the local host, never writes, and prints the fix for
anything it flags — the checks are the distilled lessons of running the
daemon on real machines.

## License

Apache-2.0
