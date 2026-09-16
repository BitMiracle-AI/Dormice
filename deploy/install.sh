#!/usr/bin/env bash
# Dormice installer: turns a bare Ubuntu/Debian x86_64 host into a running
# Dormice machine and proves it by running `dor doctor`. Two roles, one
# script:
#
#   The gateway's machine (the default): the gateway (the fleet's one door:
#   configuration, keys, the web console), the fleet's image registry, and
#   a daemon (a node that runs sandboxes) — on one machine, a fleet of one.
#
#     curl -fsSL https://raw.githubusercontent.com/BitMiracle-AI/Dormice/main/deploy/install.sh | bash
#
#   A node machine (--role node): a daemon alone, joined to a gateway on
#   another machine. Told the gateway's address once, at its first install,
#   and nothing else — the fleet's settings, the base image and the
#   templates come from the gateway at its first check-in, images it lacks
#   from the fleet's registry. The fleet token comes from the environment
#   (never a flag: flags show in `ps`; exported, not prefixed — a prefix
#   would bind to curl, not to bash):
#
#     export DORMICE_API_TOKEN=<the gateway machine's token>
#     curl -fsSL .../install.sh | bash -s -- --role node --gateway http://10.0.0.5:80
#
#   :80 there is the gateway machine's Caddy (or the operator's own reverse
#   proxy in front of the gateway): the gateway itself listens on loopback
#   only, like the daemon, so its own port answers no other machine.
#
#   The role is not a file: /etc/dormice/env names the gateway
#   (DORMICE_GATEWAY_ENDPOINT), and a remote one is what makes a machine a
#   node machine. Re-runs — upgrades — need no flags on either role.
#
# Flags (pass after `bash -s --` when piping):
#   --mirror cn         use mainland-China mirrors for every download
#   --swap-gb N         size of the swapfile to create when the host has no
#                       swap (default 16 — the configuration freezing was
#                       measured on)
#   --status-dir D      write status.json into D as the run progresses — how
#                       the one-click upgrade reads the outcome back; a manual
#                       run doesn't need it
#   --role node         first install of a node machine (see above)
#   --gateway URL       the gateway this node joins (--role node, first install)
#   --node-id ID        this node's name in the fleet (--role node, first
#                       install; default: the hostname)
#   --node-endpoint URL where the gateway reaches this node (--role node,
#                       first install; default: http://<this machine's
#                       address toward the gateway>:80)
#   --registry-addr H:P the address the fleet registry listens on and the
#                       nodes pull from (gateway's machine, first install;
#                       default: this machine's private address, port 5000
#                       — a re-run keeps the address gateway.env holds)
#   The four fleet flags (--gateway, --node-id, --node-endpoint,
#   --registry-addr) are judged against the role before anything is
#   installed: one on the other role's machine, or one contradicting the
#   env file on a re-run, is refused — never silently ignored.
#
# Four promises, mirroring `dor doctor`:
#   - Idempotent. Every step checks before it acts; a step whose outcome is
#     already in place says [skip] and touches nothing. Re-running upgrades
#     the code and repairs drift, and never rotates your API token.
#   - Loud. Every step prints what it found and what it did.
#   - Verified. The install has not succeeded until `dor doctor` says so —
#     the same battery of checks, including the real-container probes.
#   - Restartable. On a re-run, if the build fails after `git pull` moved
#     the tree, the code is put back and rebuilt at the commit that was
#     running — the daemon in memory survives a failed upgrade anyway, but
#     it is crash-only and must stay able to restart at any moment.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# ---- pinned versions -------------------------------------------------------
# The Node version and checksum must match images/Dockerfile: the host and
# the sandboxes run the same interpreter, verified against the same official
# SHASUMS256.txt, so a poisoned mirror cannot slip a different tarball in.
NODE_VERSION=v24.18.0
NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
# gVisor is pinned to the release proven on real hardware, with checksums of
# the binaries themselves — the .sha512 files published next to the binaries
# only guard transit, not a poisoned origin.
# The git release tag is release-YYYYMMDD.N, but the storage bucket keys the
# binaries by date alone (…/releases/release/YYYYMMDD/x86_64) — GVISOR_DATE is
# that path component; keep it in sync with GVISOR_RELEASE.
GVISOR_RELEASE=release-20260622.0
GVISOR_DATE=20260622
RUNSC_SHA512=6df95d09363dbd9ee5d5c889c1549b457e1783b039ff60a8f9f16f8c94c774a2ca2eef5b1c370e36b863f6b0407b53ba3c69051c6ef051253843dabf89a6de4e
SHIM_SHA512=87c63197836574b7a2c057d2c0647d2badb679187f0b9175ecf78ac52207cdaa3f101629d3e5d165c95930ca35fe81bc26bb90fcf08e09b99c2ee047b6235ce2

# The fleet's image registry: CNCF distribution's static binary, pinned by
# the sha256 GitHub publishes beside the release tarball (checked
# 2026-09-15). A binary and a systemd unit, like caddy and runsc — not a
# container: no Docker Hub pull to mirror first, and a docker restart does
# not take the fleet's image store down with it.
REGISTRY_VERSION=3.1.1
REGISTRY_SHA256=6f330a3ba9ea1d23a6ee189f449d792595240585bb2f159123d76ac594f70dd8
REGISTRY_PORT=5000

# Docker Engine comes from Docker's apt repository (or a mirror of it), and
# apt trusts what that repository's signing key signed — a key fetched from
# the same place as the packages, so it is the key that must be pinned:
# the fingerprint Docker publishes in its install documentation (checked
# 2026-09-16 against download.docker.com and USTC's mirror).
DOCKER_GPG_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

REPO_URL=https://github.com/BitMiracle-AI/Dormice.git
INSTALL_DIR=/opt/dormice
ENV_FILE=/etc/dormice/env
GATEWAY_ENV_FILE=/etc/dormice/gateway.env
DATA_DIR=/var/lib/dormice
GATEWAY_DATA_DIR=/var/lib/dormice-gateway
REGISTRY_CONF_DIR=/etc/dormice/registry
REGISTRY_DIR=$GATEWAY_DATA_DIR/registry
DAEMON_JSON=/etc/docker/daemon.json
PORT=3676
GATEWAY_PORT=3677

# ---- flags -----------------------------------------------------------------
MIRROR=''
SWAP_GB=16
STATUS_DIR=''
ROLE_FLAG=''
GATEWAY_FLAG=''
NODE_ID_FLAG=''
NODE_ENDPOINT_FLAG=''
REGISTRY_ADDR_FLAG=''
while [ $# -gt 0 ]; do
  case "$1" in
    --mirror) MIRROR="${2:?--mirror needs a value}"; shift 2 ;;
    --mirror=*) MIRROR="${1#*=}"; shift ;;
    --swap-gb) SWAP_GB="${2:?--swap-gb needs a value}"; shift 2 ;;
    --swap-gb=*) SWAP_GB="${1#*=}"; shift ;;
    --status-dir) STATUS_DIR="${2:?--status-dir needs a value}"; shift 2 ;;
    --status-dir=*) STATUS_DIR="${1#*=}"; shift ;;
    --role) ROLE_FLAG="${2:?--role needs a value}"; shift 2 ;;
    --role=*) ROLE_FLAG="${1#*=}"; shift ;;
    --gateway) GATEWAY_FLAG="${2:?--gateway needs a value}"; shift 2 ;;
    --gateway=*) GATEWAY_FLAG="${1#*=}"; shift ;;
    --node-id) NODE_ID_FLAG="${2:?--node-id needs a value}"; shift 2 ;;
    --node-id=*) NODE_ID_FLAG="${1#*=}"; shift ;;
    --node-endpoint) NODE_ENDPOINT_FLAG="${2:?--node-endpoint needs a value}"; shift 2 ;;
    --node-endpoint=*) NODE_ENDPOINT_FLAG="${1#*=}"; shift ;;
    --registry-addr) REGISTRY_ADDR_FLAG="${2:?--registry-addr needs a value}"; shift 2 ;;
    --registry-addr=*) REGISTRY_ADDR_FLAG="${1#*=}"; shift ;;
    *) echo "install.sh: unknown flag $1 (known: --mirror cn, --swap-gb N, --status-dir D, --role node, --gateway URL, --node-id ID, --node-endpoint URL, --registry-addr HOST:PORT)" >&2; exit 1 ;;
  esac
done
if [ -n "$MIRROR" ] && [ "$MIRROR" != cn ]; then
  echo "install.sh: --mirror only knows \"cn\", got \"$MIRROR\"" >&2
  exit 1
fi
if [ -n "$ROLE_FLAG" ] && [ "$ROLE_FLAG" != node ]; then
  echo "install.sh: --role only knows \"node\" (the default install is the gateway's machine), got \"$ROLE_FLAG\"" >&2
  exit 1
fi

# log() doubles as the phase tracker: when something fails under `set -e`
# there is no message to report, but "which step" is always known.
PHASE='startup'
log()  { PHASE="$*"; printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
DIE_MSG=''
die()  { DIE_MSG="$*"; printf '\ninstall.sh: %s\n' "$*" >&2; exit 1; }

# ---- role -----------------------------------------------------------------
# Not a file of its own: the daemon's env names its gateway, and a remote
# one is what makes this a node machine — the daemon's config reads it the
# same way (a remote gateway refuses the default node id). Read before
# anything is installed, so a mistaken flag dies before it changes the
# machine. A first install with no env is the gateway's machine unless
# --role node says otherwise; a re-run needs no flag on either role.
url_host() { printf '%s' "$1" | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://##; s#/.*$##; s#^\[([^]]*)\].*$#\1#; s#:[0-9]+$##'; }
is_loopback_url() {
  case "$(url_host "$1")" in
    127.*|localhost|::1|'') return 0 ;;
    *) return 1 ;;
  esac
}
ENV_GATEWAY=''
[ -f "$ENV_FILE" ] && ENV_GATEWAY=$(sed -n 's/^DORMICE_GATEWAY_ENDPOINT=//p' "$ENV_FILE" | head -1)
if [ -n "$ENV_GATEWAY" ] && ! is_loopback_url "$ENV_GATEWAY"; then
  ROLE=node
  GATEWAY_URL=${ENV_GATEWAY%/}
elif [ "$ROLE_FLAG" = node ]; then
  if [ -f "$ENV_FILE" ]; then
    die "$ENV_FILE exists and names a gateway on this machine (or none) — this is the gateway's machine; --role node is for a machine that has never been installed. To turn it into a node, stop and disable dormice-gateway, move the env file aside, and re-run"
  fi
  [ -n "$GATEWAY_FLAG" ] || die "--role node needs --gateway http://<gateway machine>:80 — the gateway this node joins, through its machine's Caddy on :80 (the gateway itself listens on loopback only)"
  case "$GATEWAY_FLAG" in
    http://*|https://*) ;;
    *) die "--gateway must be a full URL like http://10.0.0.5:80, got \"$GATEWAY_FLAG\"" ;;
  esac
  is_loopback_url "$GATEWAY_FLAG" && die "--gateway names this machine ($GATEWAY_FLAG) — a node machine joins a gateway on another machine; the default install (no --role) is the gateway's machine"
  [ -n "${DORMICE_API_TOKEN:-}" ] || die "--role node needs the fleet token in the environment: DORMICE_API_TOKEN=<the value in the gateway machine's /etc/dormice/env> bash -s -- --role node --gateway $GATEWAY_FLAG (a flag would show in ps)"
  [ "${#DORMICE_API_TOKEN}" -ge 32 ] || die 'DORMICE_API_TOKEN must be at least 32 characters — copy it from the gateway machine: grep ^DORMICE_API_TOKEN /etc/dormice/env'
  ROLE=node
  GATEWAY_URL=${GATEWAY_FLAG%/}
else
  ROLE=gateway
  GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT"
fi

# ---- the fleet flags against the role -----------------------------------------
# Every flag but --mirror, --swap-gb and --status-dir names this machine's
# place in the fleet, and each belongs to one role: a node machine's say
# which gateway it joins and how it is known there, the gateway machine's
# where its registry listens. Judged here, once, with the role known and
# nothing installed yet. On the other role's machine a flag is read by
# nobody; on a re-run the env files hold the value, and a flag would be
# taken for a change and silently do nothing — three reviews in one day
# found one such flag each (2026-09-15), because each flag was judged
# where it was consumed, hundreds of lines and a role branch away from the
# others. A flag that repeats the env file's line is harmless; one that
# contradicts it is refused, with the edit that does change the value.
flag_against_env() { # <flag> <value> <env file> <key> <how the value is really changed>
  [ -n "$2" ] && [ -f "$3" ] || return 0
  have=$(sed -n "s/^$4=//p" "$3" | head -1)
  [ -n "$have" ] || return 0
  [ "${2%/}" = "${have%/}" ] && return 0
  die "$3 says $4=$have, $1 says $2 — $5"
}
if [ "$ROLE" = gateway ]; then
  for f in "--gateway=$GATEWAY_FLAG" "--node-id=$NODE_ID_FLAG" "--node-endpoint=$NODE_ENDPOINT_FLAG"; do
    [ -n "${f#*=}" ] || continue
    die "${f%%=*} is a node machine's flag (--role node, first install) — this is the gateway's machine, whose node is the daemon beside the gateway (DORMICE_NODE_ID in $ENV_FILE names it); re-run without it"
  done
  flag_against_env --registry-addr "$REGISTRY_ADDR_FLAG" "$GATEWAY_ENV_FILE" DORMICE_REGISTRY_ADDRESS \
    "the address is the fleet's setting: the gateway's row carries it to every node, and each pins the registry's certificate under it; it does not move with a flag — re-run without it"
else
  [ -z "$REGISTRY_ADDR_FLAG" ] || die "--registry-addr is the gateway machine's flag — a node pulls from the registry its gateway names; re-run without it"
  flag_against_env --gateway "$GATEWAY_FLAG" "$ENV_FILE" DORMICE_GATEWAY_ENDPOINT \
    "edit DORMICE_GATEWAY_ENDPOINT in the env file if the gateway really moved, then re-run without the flag"
  flag_against_env --node-id "$NODE_ID_FLAG" "$ENV_FILE" DORMICE_NODE_ID \
    "the id is the node's name in the gateway's rows and its sandboxes'; to re-join under another, edit DORMICE_NODE_ID in the env file and removeNode the old id at the gateway, then re-run without the flag"
  flag_against_env --node-endpoint "$NODE_ENDPOINT_FLAG" "$ENV_FILE" DORMICE_NODE_ENDPOINT \
    "edit DORMICE_NODE_ENDPOINT in the env file if the address really changed (the daemon reports it at its next check-in), then re-run without the flag"
fi

# ---- outcome reporting and the build rollback --------------------------------
# status.json is the one file the daemon's one-click upgrade reads back;
# without --status-dir every write is a no-op and a manual run behaves as
# always. Written to a temp name and moved so a reader never sees a torn
# file. Error text is flattened (JSON has no raw newlines) and truncated —
# the full story is always the log.
STARTED_AT=$(date -u +%FT%TZ)
OLD_SHA=''
NEW_SHA=''
status_write() { # <state> [error]
  [ -n "$STATUS_DIR" ] || return 0
  mkdir -p "$STATUS_DIR"
  local finished=null from=null to=null err=null safe
  [ "$1" != running ] && finished="\"$(date -u +%FT%TZ)\""
  [ -n "$OLD_SHA" ] && from="\"$OLD_SHA\""
  [ -n "$NEW_SHA" ] && to="\"$NEW_SHA\""
  if [ -n "${2:-}" ]; then
    safe=$(printf '%s' "$2" | tr '\n\t' '  ' | sed 's/[\\"]//g' | cut -c1-500)
    err="\"$safe\""
  fi
  printf '{"state":"%s","startedAt":"%s","finishedAt":%s,"fromCommit":%s,"toCommit":%s,"error":%s}\n' \
    "$1" "$STARTED_AT" "$finished" "$from" "$to" "$err" >"$STATUS_DIR/status.json.tmp"
  mv "$STATUS_DIR/status.json.tmp" "$STATUS_DIR/status.json"
}

# The window where a failure leaves the install broken: after `git pull`
# moved the tree (PULLED) and before the build completed (BUILT), the dist
# on disk is part new, part old — the running daemon still serves from
# memory, but being crash-only it must stay restartable. The exit trap puts
# the code back at the commit that was running and rebuilds it; the daemon
# is deliberately NOT restarted on any failure path. A fresh clone has no
# rollback target — a broken first install is honestly broken.
PULLED=''
BUILT=''
on_exit() {
  local code=$?
  [ "$code" -eq 0 ] && return 0
  local msg="${DIE_MSG:-failed during: $PHASE}"
  if [ -n "$PULLED" ] && [ -z "$BUILT" ] && [ -n "$OLD_SHA" ]; then
    log "build failed — rolling back to $OLD_SHA"
    # The rollback rebuild may itself hit the same cause (it does reuse the
    # pnpm store, so a network hiccup usually does not repeat); both
    # outcomes are reported honestly and neither restarts the daemon.
    if git -C "$INSTALL_DIR" reset --hard -q "$OLD_SHA" && build_repo; then
      note "rolled back and rebuilt at $OLD_SHA — the daemon was not restarted; fix the cause and re-run"
      status_write rolled-back "$msg"
    else
      status_write failed "$msg — and the rollback rebuild failed too: the daemon keeps running but must not restart until install.sh succeeds; fix the cause and re-run"
    fi
  else
    status_write failed "$msg"
  fi
}
trap on_exit EXIT
status_write running

# ---- preflight: the facts install.sh cannot fix ----------------------------
log 'preflight'
[ "$(uname -s)" = Linux ] || die "the daemon needs Linux (loop mounts, cgroups, gVisor) — found $(uname -s)"
[ "$(uname -m)" = x86_64 ] || die "the pinned Node and gVisor binaries are x86_64 — found $(uname -m)"
[ "$(id -u)" = 0 ] || die 'run as root — loop mounts, mkfs and cgroup writes need it'
command -v apt-get >/dev/null || die 'this installer knows apt-based distros (Ubuntu/Debian) only'
grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null \
  || die 'cgroup v2 with the memory controller is required (default on Ubuntu 22.04+) — freezing writes memory.reclaim'
note "Linux x86_64, root, cgroup v2 — ok"

# ---- base packages ---------------------------------------------------------
log 'base packages (git, curl, openssl, zstd, gpg)'
missing=''
# zstd: the archiver's tar -I zstd runs on the host at every archive/restore.
# gpg: checks the fingerprint of Docker's signing key below (package gnupg).
for tool in git curl openssl zstd gpg; do
  command -v "$tool" >/dev/null || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  apt-get update -q
  # shellcheck disable=SC2086 # word splitting is the point
  apt-get install -qy ca-certificates ${missing/ gpg/ gnupg}
  note "installed:$missing"
else
  note '[skip] all present'
fi

# ---- Node ------------------------------------------------------------------
log "Node.js $NODE_VERSION"
if command -v node >/dev/null && [ "$(node -p 'process.version.slice(1).split(".")[0]')" -ge 22 ]; then
  note "[skip] $(node --version) already satisfies >= 22"
else
  node_dist=https://nodejs.org/dist
  [ "$MIRROR" = cn ] && node_dist=https://npmmirror.com/mirrors/node
  tarball="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "/tmp/$tarball" "$node_dist/$NODE_VERSION/$tarball"
  echo "$NODE_SHA256  /tmp/$tarball" | sha256sum -c - >/dev/null
  tar -xJf "/tmp/$tarball" -C /opt && rm "/tmp/$tarball"
  for b in node npm npx corepack; do
    ln -sf "/opt/node-$NODE_VERSION-linux-x64/bin/$b" "/usr/local/bin/$b"
  done
  note "installed $(node --version) to /opt, linked into /usr/local/bin"
fi
# The systemd unit execs /usr/local/bin/node unconditionally, but a host whose
# own Node satisfied the version check keeps it elsewhere (e.g. /usr/bin/node)
# — link whatever node passed the check so the unit can always start.
if [ ! -x /usr/local/bin/node ]; then
  node_path=$(command -v node)
  ln -sf "$node_path" /usr/local/bin/node
  note "linked $node_path -> /usr/local/bin/node (the path dormice.service execs)"
fi

# ---- Docker ----------------------------------------------------------------
# Docker Engine from Docker's apt repository — the recipe its documentation
# gives for production hosts (a keyring, a source line, the packages), not
# its convenience script: that is unpinned code from the network run as
# root, where every other binary this installer fetches is checksummed, and
# its mainland fallbacks failed in turn on two fresh VMs an hour apart
# (2026-09-16: get.docker.com resetting the connection, the aliyun mirror
# of the repository out of sync for over an hour, the Azure mirror lagging
# the package list). One path: the repository from Docker, under --mirror
# cn from USTC's mirror of it, and the signing key's fingerprint checked
# against the one Docker publishes before apt is told to trust it.
log 'Docker'
if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  note "[skip] dockerd $(docker version --format '{{.Server.Version}}') is running"
else
  docker_repo=https://download.docker.com
  [ "$MIRROR" = cn ] && docker_repo=https://mirrors.ustc.edu.cn/docker-ce
  # shellcheck disable=SC1091 # the host's own os-release, not a script of ours
  read -r os_id os_codename < <(. /etc/os-release && echo "$ID $VERSION_CODENAME")
  [ -n "${os_codename:-}" ] || die "/etc/os-release names no VERSION_CODENAME — Docker's repository is laid out by release codename; install Docker Engine by hand (https://docs.docker.com/engine/install/), then re-run"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL --retry 3 --retry-all-errors -o /etc/apt/keyrings/docker.asc "$docker_repo/linux/$os_id/gpg"
  docker_fpr=$(gpg --show-keys --with-fingerprint --with-colons /etc/apt/keyrings/docker.asc 2>/dev/null | awk -F: '/^fpr/ { print $10; exit }')
  [ "$docker_fpr" = "$DOCKER_GPG_FINGERPRINT" ] \
    || die "the signing key at $docker_repo/linux/$os_id/gpg has fingerprint ${docker_fpr:-none}, not Docker's $DOCKER_GPG_FINGERPRINT — that is not Docker's repository; try without --mirror, or install Docker Engine by hand (https://docs.docker.com/engine/install/) and re-run"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] $docker_repo/linux/$os_id $os_codename stable" >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  # The engine, its CLI, containerd, and buildx — the builder `docker build`
  # runs the base image through.
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  systemctl enable --now docker
  note "installed dockerd $(docker version --format '{{.Server.Version}}') from $docker_repo"
fi

# ---- daemon.json: icc off + log rotation -----------------------------------
# Merged key by key, never overwritten: the operator's registry mirrors and
# whatever `runsc install` wrote must survive. A daemon.json that exists but
# is not valid JSON is the operator's to fix — guessing would destroy it.
log 'Docker daemon.json (icc: false, log rotation)'
if [ -f "$DAEMON_JSON" ] && ! node -e "JSON.parse(require('fs').readFileSync('$DAEMON_JSON','utf8'))" 2>/dev/null; then
  die "$DAEMON_JSON exists but is not valid JSON — fix it by hand, then re-run"
fi
mkdir -p /etc/docker
daemon_json_result=$(node - "$DAEMON_JSON" <<'EOF'
const fs = require('fs');
const path = process.argv[2];
let config = {};
try { config = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
const before = JSON.stringify(config);
config.icc = false;
const rotates = config['log-driver'] === 'local' || config['log-opts']?.['max-size'];
if (!rotates) {
  config['log-driver'] = 'json-file';
  config['log-opts'] = { ...config['log-opts'], 'max-size': '10m', 'max-file': '3' };
}
if (JSON.stringify(config) === before) { console.log('unchanged'); process.exit(0); }
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log('changed');
EOF
)
if [ "$daemon_json_result" = changed ]; then
  note "updated $DAEMON_JSON — restarting docker (this stops running containers)"
  systemctl restart docker
else
  note '[skip] already configured'
fi

# ---- gVisor ----------------------------------------------------------------
log "gVisor ($GVISOR_RELEASE)"
if docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
  note "[skip] runsc is a registered Docker runtime ($(runsc --version | head -1))"
else
  if [ ! -x /usr/local/bin/runsc ]; then
    gvisor_url="https://storage.googleapis.com/gvisor/releases/release/$GVISOR_DATE/x86_64"
    for bin in runsc containerd-shim-runsc-v1; do
      curl -fsSL -o "/tmp/$bin" "$gvisor_url/$bin" || die "cannot download $bin from $gvisor_url —
    if this host cannot reach storage.googleapis.com, download runsc and
    containerd-shim-runsc-v1 ($GVISOR_RELEASE, x86_64) on a machine that can,
    copy them to /usr/local/bin/ here, then re-run this script: it verifies
    their checksums and continues from where it left off"
    done
    echo "$RUNSC_SHA512  /tmp/runsc" | sha512sum -c - >/dev/null
    echo "$SHIM_SHA512  /tmp/containerd-shim-runsc-v1" | sha512sum -c - >/dev/null
    chmod a+rx /tmp/runsc /tmp/containerd-shim-runsc-v1
    mv /tmp/runsc /tmp/containerd-shim-runsc-v1 /usr/local/bin/
  fi
  echo "$RUNSC_SHA512  /usr/local/bin/runsc" | sha512sum -c - >/dev/null \
    || die "/usr/local/bin/runsc does not match the pinned $GVISOR_RELEASE checksum"
  # --allow-suid from birth: sudo inside a sandbox is setuid elevation, and
  # the sentry ignores SUID bits without it. The merge step below is the
  # arbiter; passing it here just means fresh installs need no second
  # docker restart.
  /usr/local/bin/runsc install -- --allow-suid
  systemctl restart docker
  note "installed $(runsc --version | head -1), registered with Docker"
fi

# ---- gVisor: --allow-suid ---------------------------------------------------
# The single arbiter of the flag, idempotent: hosts installed before
# 2026-08-31 have runsc registered without it, so sudo inside their
# sandboxes fails — re-running this script upgrades them. The executor's
# half of the same decision is omitting no-new-privileges (docker.ts).
log 'gVisor --allow-suid (sudo inside sandboxes)'
allow_suid_result=$(node - "$DAEMON_JSON" <<'EOF'
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = process.argv[2];
let config = {};
try { config = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
// Only the entry runsc install writes is ours to edit. A registration that
// lives elsewhere (a dockerd --add-runtime flag or systemd drop-in) must not
// be duplicated here: dockerd refuses to start when the same directive
// arrives from both a flag and daemon.json.
const runsc = config.runtimes?.runsc;
if (!runsc) { console.log('foreign'); process.exit(0); }
const args = runsc.runtimeArgs ?? [];
if (args.includes('--allow-suid')) { console.log('unchanged'); process.exit(0); }
// A pre-existing registration is honored, not upgraded (the gVisor section
// above), so this runsc can predate the flag (gVisor < release-20250813) —
// and dockerd would accept the config write, then refuse every container
// create with "flag provided but not defined". Ask the actual binary first:
// --version, the flag — runsc has no `version` subcommand (measured on
// release-20260622.0: `runsc <anything> version` exits 128 with usage, which
// would misread every host as unsupported). An unknown flag exits non-zero
// before --version can answer, so exit 0 means exactly "flag accepted".
try {
  execFileSync(runsc.path, ['--allow-suid', '--version'], { stdio: 'ignore' });
} catch { console.log('unsupported'); process.exit(0); }
runsc.runtimeArgs = [...args, '--allow-suid'];
config.runtimes = { ...config.runtimes, runsc };
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log('changed');
EOF
)
case "$allow_suid_result" in
changed)
  note "added --allow-suid to the runsc runtime — restarting docker (this stops running containers; frozen/active sandboxes reconcile to stopped, disks are untouched)"
  systemctl restart docker
  ;;
unsupported)
  note "this host's runsc does not support --allow-suid (needs gVisor release-20250813 or newer) — sandboxes work, but sudo inside them will fail; upgrade gVisor, then re-run"
  ;;
foreign)
  note "runsc is registered outside $DAEMON_JSON (a dockerd flag or drop-in) — sandboxes work, but sudo inside them needs --allow-suid added to that registration by hand"
  ;;
*)
  note '[skip] already configured'
  ;;
esac

# ---- swap ------------------------------------------------------------------
# Freezing squeezes sandbox memory out to swap; without swap the measured
# result is 0 bytes reclaimed. The swapfile goes on the root filesystem.
log 'swap'
swap_kb=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
if [ "$swap_kb" -gt 0 ]; then
  note "[skip] $((swap_kb / 1024 / 1024)) GiB of swap already present"
else
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
  note "created a ${SWAP_GB} GiB /swapfile, persisted in /etc/fstab"
fi

# ---- kernel parameters (sysctl) ----------------------------------------------
# vm.swappiness=100: gVisor holds sandbox memory as shared memory, which the
# kernel refuses to swap below swappiness 100 (measured at 60: 0 bytes
# reclaimed). net.ipv4.ip_forward=1: bridge networking dies without it, and
# although dockerd flips it on at every daemon start, a boot config that says
# 0 comes back at the next config replay and silently cuts every sandbox's
# network. The file is named to sort after cloud-vendor sysctl.d files that
# ship swappiness=0. Applied scoped — `sysctl --system` here would replay
# every operator setting mid-install (an ip_forward=0 in /etc/sysctl.conf did
# exactly that and killed the base-image build two steps later). Two replays
# can overwrite these keys later, and both are verified: systemd-sysctl's
# boot order (a global sort across the sysctl.d dirs, last setter wins), and
# procps `sysctl --system`, which reads /etc/sysctl.conf LAST — even without
# the 99-sysctl.conf symlink. In each order the winning value of every key
# must be the one we need. The value, not the file — a host may legitimately
# set ip_forward=1 in its own later-sorting config (the test host does), and
# that is agreement, not a conflict.
#
# fs.inotify.max_user_instances is a floor, not an exact match: each running
# sandbox's containerd shim opens one inotify instance to watch its cgroup
# for OOM events, and that is how Docker's State.OOMKilled — the only kernel
# OOM verdict that survives the container's death — is set at all. The
# distro default of 128 is exhausted by a host running a few hundred
# sandboxes (measured 2026-09-09 on a production host: 415 shims, 128
# instances, ~300 shims with no OOM watch and every OOM on them silently
# recorded as a plain exit). Below the floor the relay fails silently; a host
# that sets it higher is agreement. Sandboxes cannot consume host instances —
# gVisor virtualizes their inotify inside the sentry — so a generous ceiling
# costs nothing.
log 'kernel parameters (swappiness 100, ip_forward 1, inotify instances 8192)'
SYSCTL_FILE=/etc/sysctl.d/99-dormice.conf
sysctl_wanted='# Managed by Dormice install.sh — rewritten on every run.
vm.swappiness=100
net.ipv4.ip_forward=1
fs.inotify.max_user_instances=8192'
# Keys verified as a floor (winner must be >= ours) rather than an exact
# match — more is only better.
sysctl_floor_keys=' fs.inotify.max_user_instances '
if [ "$(cat "$SYSCTL_FILE" 2>/dev/null)" = "$sysctl_wanted" ]; then
  note "[skip] $SYSCTL_FILE is in place"
else
  printf '%s\n' "$sysctl_wanted" >"$SYSCTL_FILE"
  note "wrote $SYSCTL_FILE (survives reboot)"
fi
sysctl -p "$SYSCTL_FILE" >/dev/null
systemd_sysctl=/usr/lib/systemd/systemd-sysctl
[ -x "$systemd_sysctl" ] || systemd_sysctl=/lib/systemd/systemd-sysctl
[ -x "$systemd_sysctl" ] \
  || die 'cannot find systemd-sysctl to verify the sysctl boot order — non-systemd hosts are not supported'
# Last setter of `$1` in a sysctl config stream (stdin, or the file `$2`),
# printed as
# `file|value`. A file marker is a comment that IS a path and nothing else
# (`# /path`) — `--cat-config` emits one before each file's lines; a comment
# merely starting with `# /` (the stock sysctl.conf header is one) is
# skipped like any other; `$2`, when given, is a marker-less file to read
# and the name to report for it. Keys
# tolerate the `- key` ignore-error form and `/` as the separator; values
# keep internal whitespace and shed CRLF. Kept in sync by hand with
# sysctlBootWinner in packages/cli/src/doctor.ts.
sysctl_winner() {
  awk -v key="$1" -v file="${2:-unknown}" '
    /^# \// && NF == 2 { file = $2; next }
    /^[ \t\r]*[#;]/    { next }
    {
      eq = index($0, "="); if (eq == 0) next
      k = substr($0, 1, eq - 1); gsub(/[ \t\r]/, "", k); sub(/^-/, "", k); gsub("/", ".", k)
      if (k != key) next
      v = substr($0, eq + 1); sub(/^[ \t\r]+/, "", v); sub(/[ \t\r]+$/, "", v)
      print file "|" v
    }' ${2:+"$2"} | tail -n 1
}
cat_config=$("$systemd_sysctl" --cat-config)
for kv in $(printf '%s\n' "$sysctl_wanted" | grep -v '^#'); do
  key=${kv%%=*} want=${kv#*=}
  winner=$(printf '%s\n' "$cat_config" | sysctl_winner "$key")
  [ -n "$winner" ] \
    || die "could not find $key anywhere in systemd-sysctl --cat-config output — expected at least $SYSCTL_FILE to appear; parse failure"
  # A floor key agrees when the winner is at least ours; every other key
  # needs the exact value (dockerd flips ip_forward, a cloud file may pin
  # swappiness — either drifting either way is a conflict).
  case "$sysctl_floor_keys" in
    *" $key "*)
      [ "${winner#*|}" -ge "$want" ] 2>/dev/null \
        || die "$key must be at least $want at boot, but the sysctl boot order ends with ${winner%%|*} setting it to ${winner#*|} — raise or remove that line, then re-run" ;;
    *)
      [ "${winner#*|}" = "$want" ] \
        || die "$key must be $want at boot, but the sysctl boot order ends with ${winner%%|*} setting it to ${winner#*|} — change or remove that line, then re-run" ;;
  esac
  # procps `sysctl --system` (other installers run it) applies
  # /etc/sysctl.conf after every sysctl.d file, symlink or not — a
  # disagreeing value there overrides us at the very next replay even when
  # the systemd boot order ends with ours.
  if [ -f /etc/sysctl.conf ]; then
    conf_value=$(sysctl_winner "$key" /etc/sysctl.conf)
    conf_value=${conf_value#*|}
    case "$sysctl_floor_keys" in
      *" $key "*)
        [ -z "$conf_value" ] || [ "$conf_value" -ge "$want" ] 2>/dev/null \
          || die "$key must be at least $want, but /etc/sysctl.conf sets it to $conf_value — procps sysctl --system applies that file last, so the next config replay overrides us; raise or remove that line, then re-run" ;;
      *)
        [ -z "$conf_value" ] || [ "$conf_value" = "$want" ] \
          || die "$key must be $want, but /etc/sysctl.conf sets it to $conf_value — procps sysctl --system applies that file last, so the next config replay overrides us; change or remove that line, then re-run" ;;
    esac
  fi
done
note 'verified: the sysctl keys survive the boot order and a procps sysctl --system replay'

# ---- cloud metadata firewall -------------------------------------------------
# Sandboxes run untrusted code; on a cloud host with an attached role, one
# curl to the metadata service steals live credentials. gVisor blocks kernel
# attack surface, not network reachability — this must be firewalled.
log 'cloud metadata firewall (DOCKER-USER chain)'
iptables -w 10 -S DOCKER-USER >/dev/null 2>&1 \
  || die 'the DOCKER-USER chain is missing — is dockerd running?'
# One list, one writer: the oneshot unit below is the only mechanism that
# inserts the rules — after docker creates the DOCKER-USER chain at boot
# (docker never flushes that chain afterwards), and right here via the
# restart. Deliberately NOT iptables-persistent: installing it makes apt
# remove ufw (the packages conflict) — silently discarding an operator's
# firewall — and `netfilter-persistent save` snapshots the whole ruleset,
# operator rules and Docker's ephemeral NAT entries included, when exactly
# two rules are ours to persist. Hosts persisted the old way keep their
# /etc/iptables/rules.v4 untouched; the -C checks make duplicates impossible.
# Every iptables call waits for the xtables lock (-w 10): at boot the unit
# races dockerd for that lock, and without -w a lost race fails the unit
# and silently leaves the metadata service reachable.
METADATA_TARGETS='169.254.0.0/16 100.100.100.200'
FIREWALL_UNIT=/etc/systemd/system/dormice-metadata-firewall.service
firewall_exec=$(for target in $METADATA_TARGETS; do
  printf "ExecStart=/bin/sh -c 'iptables -w 10 -C DOCKER-USER -d %s -j DROP 2>/dev/null || iptables -w 10 -I DOCKER-USER -d %s -j DROP'\n" "$target" "$target"
done)
firewall_unit=$(cat <<EOF
# Written by Dormice install.sh — rewritten on every run. Sandboxes run
# untrusted code; these rules keep them away from the cloud metadata service.
[Unit]
Description=Dormice: block cloud metadata endpoints from containers
After=docker.service
Requires=docker.service
Before=dormice.service

[Service]
Type=oneshot
RemainAfterExit=yes
$firewall_exec

[Install]
WantedBy=multi-user.target
EOF
)
if [ "$(cat "$FIREWALL_UNIT" 2>/dev/null)" = "$firewall_unit" ]; then
  note '[skip] persistence unit is in place'
else
  printf '%s\n' "$firewall_unit" >"$FIREWALL_UNIT"
  systemctl daemon-reload
  note "wrote $FIREWALL_UNIT (re-adds the rules after docker starts — survives reboot)"
fi
systemctl -q enable dormice-metadata-firewall
missing_before=''
for target in $METADATA_TARGETS; do
  iptables -w 10 -C DOCKER-USER -d "$target" -j DROP 2>/dev/null \
    || missing_before="$missing_before $target"
done
# Restarted now, not only at boot: the unit is the only rule-writer, so this
# restart IS the mechanism — a fresh install exercises the -C||-I insert
# path (rules absent), a re-run the -C path, and -C keeps it idempotent.
systemctl restart dormice-metadata-firewall
for target in $METADATA_TARGETS; do
  iptables -w 10 -C DOCKER-USER -d "$target" -j DROP 2>/dev/null \
    || die "the unit ran but the rule for $target is absent — journalctl -u dormice-metadata-firewall has the story"
done
if [ -n "$missing_before" ]; then
  note "the unit added DROP rules:$missing_before"
else
  note '[skip] both DROP rules were in place — the unit re-confirmed them'
fi

# ---- Dormice code -----------------------------------------------------------
# Defined before the pull so the rollback in on_exit can always call it.
# Deps then build, from a clean tree at whatever commit is checked out —
# the same path for the fresh install, the upgrade, and the rollback.
build_repo() {
  cd "$INSTALL_DIR"
  # better-sqlite3 is a native module: its install takes a prebuilt binary
  # from GitHub — under --mirror cn from npmmirror's copy of those releases,
  # GitHub being the first host a mainland machine cannot reach (a fresh VM
  # timed out on it and then on nodejs.org, 2026-09-16) — and compiles
  # otherwise, for which node-gyp downloads this Node's headers from
  # nodejs.org: needlessly when the interpreter came with them. A Node
  # unpacked from its tarball (the one this script puts in /opt) carries
  # them under include/node, and node-gyp is pointed at the running Node's
  # own copy whenever there is one.
  local node_home
  node_home=$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")
  if [ -f "$node_home/include/node/node.h" ]; then
    export npm_config_nodedir="$node_home"
  fi
  if [ "$MIRROR" = cn ]; then
    export npm_config_better_sqlite3_binary_host_mirror=https://npmmirror.com/mirrors/better-sqlite3
    npm_config_registry=https://registry.npmmirror.com pnpm install --frozen-lockfile
  else
    pnpm install --frozen-lockfile
  fi
  # Build only what a Dormice host runs: the server (plus its workspace deps),
  # the CLI, the console SPA — and the gateway, whose dist must move with the
  # daemon's on a machine that runs both (the single-machine install is a
  # fleet of one): a gateway left on an older dist runs it at its next
  # restart, against a daemon whose check-in it may no longer parse. Seconds
  # to build. The website package is the project's Next.js marketing site —
  # building it here would cost minutes and import a frontend toolchain's
  # failure modes into an installer whose job is the daemon.
  pnpm --filter "@dormice/server..." --filter "@dormice/gateway..." --filter "@dormice/cli..." --filter "@dormice/console" build
}

log "Dormice code ($INSTALL_DIR)"
clone_url=$REPO_URL
[ "$MIRROR" = cn ] && clone_url="https://ghfast.top/$REPO_URL"
if [ -d "$INSTALL_DIR/.git" ]; then
  OLD_SHA=$(git -C "$INSTALL_DIR" rev-parse --short HEAD)
  git -C "$INSTALL_DIR" pull --ff-only -q
  PULLED=1
  note "updated to $(git -C "$INSTALL_DIR" log --oneline -1)"
else
  git clone -q "$clone_url" "$INSTALL_DIR"
  note "cloned $(git -C "$INSTALL_DIR" log --oneline -1)"
fi
NEW_SHA=$(git -C "$INSTALL_DIR" rev-parse --short HEAD)
status_write running

log 'build'
pnpm_version=$(node -p "require('$INSTALL_DIR/package.json').packageManager.split('@')[1]")
if ! command -v pnpm >/dev/null || [ "$(pnpm --version)" != "$pnpm_version" ]; then
  pnpm_path=$(command -v pnpm || true)
  if [ -n "$pnpm_path" ] && readlink -f "$pnpm_path" 2>/dev/null | grep -q corepack; then
    # The host's pnpm is a corepack shim (Node >= 16.9 ships corepack, and
    # `corepack enable` shims pnpm next to node). npm install -g refuses to
    # overwrite a binary it does not own and dies with EEXIST — so pin the
    # version through corepack, the shim's actual owner, instead.
    [ "$MIRROR" = cn ] && export COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
    corepack prepare "pnpm@$pnpm_version" --activate
    note "pinned pnpm@$pnpm_version via corepack (the host's pnpm is a corepack shim)"
  elif [ "$MIRROR" = cn ]; then
    npm install -g "pnpm@$pnpm_version" --registry=https://registry.npmmirror.com >/dev/null
  else
    npm install -g "pnpm@$pnpm_version" >/dev/null
  fi
  # npm -g installs into the active Node's prefix; when that is our /opt
  # Node, the binary needs a link onto PATH.
  if [ -x "/opt/node-$NODE_VERSION-linux-x64/bin/pnpm" ]; then
    ln -sf "/opt/node-$NODE_VERSION-linux-x64/bin/pnpm" /usr/local/bin/pnpm
  fi
fi
build_repo
BUILT=1
ln -sf "$INSTALL_DIR/packages/cli/dist/main.js" /usr/local/bin/dormice
ln -sf "$INSTALL_DIR/packages/cli/dist/main.js" /usr/local/bin/dor
note "built; \`dormice\` and \`dor\` linked into /usr/local/bin"

# ---- ingress (Caddy reverse proxy) -------------------------------------------
# Gateway and daemon bind 127.0.0.1 by design; Caddy on :80 is what makes
# them reachable from outside. On the gateway's machine it proxies to the
# GATEWAY — the fleet's one door, which serves the console and forwards
# the sandbox verbs — and its file is also what the gateway rewrites when
# the operator binds a domain in the console (setIngress); Caddy then
# obtains and renews the TLS certificate on its own. On a node machine it
# proxies to the daemon: the gateway reaches the node through it. Pinned
# binary with checksum, same posture as gVisor.
log 'ingress (Caddy reverse proxy)'
CADDY_VERSION=2.10.0
CADDY_SHA512=626682d623ca04356ab3c9a93a82386cfde6d8243b11f2d0eea9e97ba630c7ada62373401e96b72c6690c98ae8dd004d61fafe477f5249690d5cb251ebbfd2d9
CADDYFILE=/etc/caddy/Caddyfile
if command -v caddy >/dev/null; then
  note "[skip] caddy is installed ($(caddy version | cut -d' ' -f1))"
elif ss -ltnH 'sport = :80' 2>/dev/null | grep -q .; then
  # Another server owns port 80: never fight it. The operator keeps their
  # proxy (point it at the gateway, or at the daemon on a node machine);
  # web domain binding stays off.
  note "port 80 is already in use and caddy is not installed — skipping the ingress layer"
  if [ "$ROLE" = node ]; then
    note "point your own reverse proxy at 127.0.0.1:$PORT (the daemon) — the gateway reaches this node through it"
  else
    note "point your own reverse proxy at 127.0.0.1:$GATEWAY_PORT (the gateway); the console's domain binding stays disabled"
  fi
else
  caddy_url="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
  [ "$MIRROR" = cn ] && caddy_url="https://ghfast.top/$caddy_url"
  curl -fsSL -o /tmp/caddy.tar.gz "$caddy_url"
  echo "$CADDY_SHA512  /tmp/caddy.tar.gz" | sha512sum -c - >/dev/null
  tar -C /tmp -xzf /tmp/caddy.tar.gz caddy
  install -m 755 /tmp/caddy /usr/local/bin/caddy
  rm -f /tmp/caddy.tar.gz /tmp/caddy
  note "installed caddy v$CADDY_VERSION to /usr/local/bin"
fi
INGRESS_FILE_READY=''
CADDY_REPOINT_PENDING=''
if command -v caddy >/dev/null; then
  mkdir -p /etc/caddy
  if [ "$ROLE" = node ]; then
    # The node's door: :80 to the daemon, Host and streams preserved. No
    # Dormice marker — this file is the installer's, never setIngress's
    # (domains are bound at the gateway). No source-IP gate either: the
    # node judges every request by the fleet token, a signed URL or an
    # access token, and the fence around :80 is the cloud security group
    # (design record #34) — a gateway that moves must not mean editing
    # every node.
    if [ ! -f "$CADDYFILE" ]; then
      cat >"$CADDYFILE" <<EOF
# Written by Dormice install.sh (node machine): the gateway reaches this
# node's daemon through :80. Allow :80 from the gateway machine only, in
# your cloud firewall.

:80 {
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
      note "wrote $CADDYFILE (:80 to the daemon — allow :80 from the gateway machine in your cloud firewall)"
    elif grep -q "reverse_proxy 127.0.0.1:$PORT\b" "$CADDYFILE"; then
      note "[skip] $CADDYFILE already proxies to the daemon"
    else
      note "$CADDYFILE exists and does not proxy to 127.0.0.1:$PORT — left untouched; make sure the gateway can reach this node's daemon through it"
    fi
  else
    # The gateway machine's door. Which file the gateway owns is the
    # gateway's knob (DORMICE_INGRESS_FILE): one file by default, or — the
    # production layout — a fragment the operator's own Caddyfile imports
    # (the outer file holds their wildcard sandbox domain block and the
    # import line). Only the owned file, and only under its marker, is
    # ever edited here; anything else under /etc/caddy still pointing at
    # the daemon is named, not touched (found on both production machines,
    # 2026-09-14: the earlier re-point reached neither file).
    ingress_target=''
    [ -f "$GATEWAY_ENV_FILE" ] && ingress_target=$(sed -n 's/^DORMICE_INGRESS_FILE=//p' "$GATEWAY_ENV_FILE" | head -1)
    [ -z "$ingress_target" ] && [ -f "$ENV_FILE" ] && ingress_target=$(sed -n 's/^DORMICE_INGRESS_FILE=//p' "$ENV_FILE" | head -1)
    [ -n "$ingress_target" ] || ingress_target=$CADDYFILE
    ingress_reload=''
    [ -f "$GATEWAY_ENV_FILE" ] && ingress_reload=$(sed -n 's/^DORMICE_INGRESS_RELOAD_CMD=//p' "$GATEWAY_ENV_FILE" | head -1)
    [ -z "$ingress_reload" ] && [ -f "$ENV_FILE" ] && ingress_reload=$(sed -n 's/^DORMICE_INGRESS_RELOAD_CMD=//p' "$ENV_FILE" | head -1)
    ingress_reload=$(printf '%s' "$ingress_reload" | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')
    [ -n "$ingress_reload" ] || ingress_reload="caddy reload --config $CADDYFILE --adapter caddyfile"
    if [ ! -f "$ingress_target" ]; then
      if [ "$ingress_target" = "$CADDYFILE" ]; then
        # The marker below is the ownership contract: the gateway refuses
        # to rewrite a Caddyfile that lacks it. Kept in sync by hand with
        # packages/gateway/src/ingress.ts.
        cat >"$CADDYFILE" <<EOF
# Managed by Dormice — setIngress rewrites this file.

:80 {
	reverse_proxy 127.0.0.1:$GATEWAY_PORT {
		flush_interval -1
	}
}
EOF
        note "wrote $CADDYFILE (plain HTTP on :80 to the gateway — bind domains in the console's domains page for HTTPS)"
      else
        note "$ingress_target (DORMICE_INGRESS_FILE) does not exist yet — the gateway writes it at the first domain bind"
      fi
      INGRESS_FILE_READY=1
    elif grep -q 'Managed by Dormice' "$ingress_target"; then
      if grep -q "reverse_proxy 127.0.0.1:$PORT\b" "$ingress_target"; then
        # A file from before the gateway became the door (2026-09-14): the
        # catch-all still points at the daemon, where the console no longer
        # lives. Re-pointed in place — but in the services step below, once
        # the gateway answers: done here, the machine's public API face
        # would proxy to a port nobody listens on from this line until the
        # gateway's first start, past the registry install, the base image
        # push, the backups and the import — minutes on a production
        # ledger (found by review, 2026-09-16). The bound domains, if any,
        # are rewritten the same way by the gateway at the next setIngress.
        note "$ingress_target still proxies to the daemon ($PORT) — re-pointed to the gateway ($GATEWAY_PORT) once it answers, below"
        CADDY_REPOINT_PENDING=1
      else
        note "[skip] $ingress_target is managed by Dormice — left to the gateway"
      fi
      INGRESS_FILE_READY=1
    else
      note "$ingress_target exists but was not written by Dormice — left untouched; domain binding will refuse to overwrite it"
      INGRESS_FILE_READY=1
    fi
    # The hand-written files (an outer Caddyfile importing the fragment,
    # with the wildcard sandbox domain block): a proxy line there still
    # aimed at the daemon sends the sandbox domain past the gateway's port
    # proxy face. Named with file and line; the operator edits their own
    # file.
    leftovers=$(grep -rn "reverse_proxy 127.0.0.1:$PORT\b" /etc/caddy 2>/dev/null | grep -v "^$ingress_target:" || true)
    if [ -n "$leftovers" ]; then
      note "WARNING: these lines under /etc/caddy still proxy to the daemon ($PORT) — change them to 127.0.0.1:$GATEWAY_PORT by hand (the gateway is the door for every face, the sandbox domain included) and reload caddy:"
      printf '%s\n' "$leftovers" | sed 's/^/      /'
    fi
  fi
  if [ ! -f /etc/systemd/system/caddy.service ]; then
    cat >/etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy reverse proxy for Dormice
After=network.target

[Service]
ExecStart=/usr/local/bin/caddy run --config $CADDYFILE
Restart=always

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    note 'wrote /etc/systemd/system/caddy.service'
  fi
  systemctl enable caddy >/dev/null 2>&1
  if [ "$(systemctl is-active caddy)" != active ]; then
    systemctl start caddy
    note 'started caddy'
  else
    note '[skip] caddy is running'
  fi
fi

# ---- daemon configuration ----------------------------------------------------
# The daemon's env is the node's identity and its machine: token, executor,
# ledger, data dir — and, on a node machine, which gateway it belongs to
# and where that gateway reaches it. The fleet's operator knobs (sandbox
# defaults, the base image, the archive store, the sandbox domain, the
# managed front door) are the gateway's since 2026-09-14: its env seeds
# them once, the console edits them, and the daemon takes them from its
# check-in. A DORMICE_BASE_IMAGE line in an older env file stays as the
# daemon's fallback while the fleet names none.
log "daemon configuration ($ENV_FILE)"
install -d -m 700 "$DATA_DIR"
if [ -f "$ENV_FILE" ]; then
  note "[skip] exists — kept as is (your API token is never rotated); delete it to regenerate"
elif [ "$ROLE" = node ]; then
  install -d -m 755 /etc/dormice
  NODE_ID=${NODE_ID_FLAG:-$(hostname)}
  if [ -n "$NODE_ENDPOINT_FLAG" ]; then
    NODE_ENDPOINT=${NODE_ENDPOINT_FLAG%/}
  else
    # The address this machine speaks to the gateway from — the one the
    # gateway can speak back to — on :80, the door Caddy opens above.
    gateway_host=$(url_host "$GATEWAY_URL")
    gateway_ip=$(getent ahostsv4 "$gateway_host" 2>/dev/null | awk 'NR==1{print $1}')
    [ -n "$gateway_ip" ] || die "cannot resolve the gateway's host $gateway_host — check --gateway, or pass --node-endpoint http://<this machine's address>:80 as well"
    node_ip=$(ip -4 route get "$gateway_ip" 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')
    [ -n "$node_ip" ] || die "cannot tell which address this machine reaches $gateway_ip from — pass --node-endpoint http://<this machine's address>:80"
    NODE_ENDPOINT="http://$node_ip:80"
  fi
  cat >"$ENV_FILE" <<EOF
# Dormice daemon (node) configuration, read by systemd (EnvironmentFile).
# Full-line comments only — an inline comment becomes part of the value.
# All knobs and defaults: packages/server/src/config.ts. This machine is a
# node of the gateway named below: the fleet's settings, the base image
# and the templates come from it at check-in, images from its registry.
DORMICE_API_TOKEN=$DORMICE_API_TOKEN
DORMICE_EXECUTOR=docker
DORMICE_DB_PATH=$DATA_DIR/dormice.db
DORMICE_DATA_DIR=$DATA_DIR
DORMICE_GATEWAY_ENDPOINT=$GATEWAY_URL
DORMICE_NODE_ID=$NODE_ID
DORMICE_NODE_ENDPOINT=$NODE_ENDPOINT
EOF
  chmod 600 "$ENV_FILE"
  note "wrote $ENV_FILE (mode 600): node $NODE_ID of gateway $GATEWAY_URL, reached at $NODE_ENDPOINT"
else
  install -d -m 755 /etc/dormice
  # No inline comments below: systemd's EnvironmentFile takes the whole line
  # as the value. Full-line comments are fine.
  cat >"$ENV_FILE" <<EOF
# Dormice daemon (node) configuration, read by systemd (EnvironmentFile).
# Full-line comments only — an inline comment becomes part of the value.
# All knobs and defaults: packages/server/src/config.ts. The fleet's
# settings (sandbox defaults, base image, archive store, sandbox domain)
# are the gateway's: /etc/dormice/gateway.env seeds them, the console
# edits them.
DORMICE_API_TOKEN=$(openssl rand -hex 32)
DORMICE_EXECUTOR=docker
DORMICE_DB_PATH=$DATA_DIR/dormice.db
DORMICE_DATA_DIR=$DATA_DIR
EOF
  chmod 600 "$ENV_FILE"
  note "wrote $ENV_FILE (mode 600) with a fresh API token"
fi
API_TOKEN=$(sed -n 's/^DORMICE_API_TOKEN=//p' "$ENV_FILE" | head -1)
[ -n "$API_TOKEN" ] || die "$ENV_FILE has no DORMICE_API_TOKEN line — the daemon cannot start without one"
# Never on a command line, never in the log: the callers below that need
# the credential read it from stdin (curl -K -, docker login
# --password-stdin) through these two helpers.
curl_auth_config() { printf 'header = "Authorization: Bearer %s"\n' "$API_TOKEN"; }
curl_basic_config() { printf 'user = "dormice:%s"\n' "$API_TOKEN"; }

# ---- gateway configuration ---------------------------------------------------
# One token for the whole fleet: the gateway's env carries the daemon's
# DORMICE_API_TOKEN verbatim (callers present it to the gateway, the daemon
# checks in with it, the gateway forwards under it). On a machine upgraded
# across the move, the fleet knobs an operator once set in the daemon's env
# are carried over as the gateway's first-boot seeds so the first bundle
# the daemon takes says what its env used to say — and are then commented
# out of the daemon's env, where they do nothing but earn a boot warning.
if [ "$ROLE" = gateway ]; then
log "gateway configuration ($GATEWAY_ENV_FILE)"
install -d -m 700 "$GATEWAY_DATA_DIR"
FLEET_KNOBS='DORMICE_SANDBOX_DISK_GB DORMICE_SANDBOX_CPUS DORMICE_SANDBOX_MEMORY_GB DORMICE_SANDBOX_PIDS_LIMIT DORMICE_SANDBOX_DOMAIN DORMICE_INGRESS_FILE DORMICE_INGRESS_RELOAD_CMD DORMICE_S3_ENDPOINT DORMICE_S3_BUCKET DORMICE_S3_ACCESS_KEY_ID DORMICE_S3_SECRET_ACCESS_KEY DORMICE_S3_REGION DORMICE_S3_FORCE_PATH_STYLE'
if [ -f "$GATEWAY_ENV_FILE" ]; then
  note "[skip] exists — kept as is"
else
  cat >"$GATEWAY_ENV_FILE" <<EOF
# Dormice gateway configuration, read by systemd (EnvironmentFile).
# Full-line comments only — an inline comment becomes part of the value.
# All knobs and defaults: packages/gateway/src/config.ts
# The one token of the fleet — the same string as in /etc/dormice/env.
DORMICE_API_TOKEN=$API_TOKEN
DORMICE_GATEWAY_DB_PATH=$GATEWAY_DATA_DIR/gateway.db
# First-boot seeds of the fleet settings; the console edits the values in
# force. Optional: the S3 archiver. Set all four to archive idle sandboxes'
# disks to any S3-compatible store (AWS, R2, MinIO, OSS in S3-compat mode)
# after a week of idleness — and restore them on the next acquire.
# Endpoint is a full URL; MinIO needs DORMICE_S3_FORCE_PATH_STYLE=true.
#DORMICE_S3_ENDPOINT=
#DORMICE_S3_BUCKET=
#DORMICE_S3_ACCESS_KEY_ID=
#DORMICE_S3_SECRET_ACCESS_KEY=
#DORMICE_S3_FORCE_PATH_STYLE=false
EOF
  carried=''
  for knob in $FLEET_KNOBS; do
    line=$(grep "^$knob=" "$ENV_FILE" | head -1 || true)
    if [ -n "$line" ]; then
      echo "$line" >>"$GATEWAY_ENV_FILE"
      sed -i "s|^$knob=|# moved to $GATEWAY_ENV_FILE (2026-09-14): $knob=|" "$ENV_FILE"
      carried="$carried $knob"
    fi
  done
  chmod 600 "$GATEWAY_ENV_FILE"
  if [ -n "$carried" ]; then
    note "wrote $GATEWAY_ENV_FILE (mode 600) with the fleet token; carried over from $ENV_FILE:$carried"
  else
    note "wrote $GATEWAY_ENV_FILE (mode 600) with the fleet token"
  fi
fi
# Appended outside the create-once block so an upgrade re-run picks the
# knob up too. The knob is what turns on web domain binding in the console.
if [ -n "$INGRESS_FILE_READY" ] && ! grep -q '^DORMICE_INGRESS_FILE=' "$GATEWAY_ENV_FILE"; then
  {
    echo '# The Caddy config file the gateway owns: enables binding domains (and'
    echo '# getting HTTPS) from the console domains page.'
    echo "DORMICE_INGRESS_FILE=$CADDYFILE"
  } >>"$GATEWAY_ENV_FILE"
  note "added DORMICE_INGRESS_FILE=$CADDYFILE to $GATEWAY_ENV_FILE"
fi
if ! grep -q "^DORMICE_API_TOKEN=$API_TOKEN\$" "$GATEWAY_ENV_FILE"; then
  die "$GATEWAY_ENV_FILE and $ENV_FILE carry different DORMICE_API_TOKEN values — the fleet has one token; make them the same and re-run"
fi
fi

# ---- sandbox base image (gateway's machine) ----------------------------------
# The fleet's base image is a fleet setting since 2026-09-15 (the gateway's
# settings table, seeded from its env, carried to every node in the
# bundle): built here once, pushed to the fleet registry below, pulled by
# every node that lacks it. The tag in force: the gateway's seed, else an
# older daemon env's line (the knob's old home), else a fresh build.
if [ "$ROLE" = gateway ]; then
log 'sandbox base image'
existing_image=$(sed -n 's/^DORMICE_BASE_IMAGE=//p' "$GATEWAY_ENV_FILE" | head -1)
[ -n "$existing_image" ] || existing_image=$(sed -n 's/^DORMICE_BASE_IMAGE=//p' "$ENV_FILE" | head -1)
if [ -n "$existing_image" ] && docker image inspect "$existing_image" >/dev/null 2>&1; then
  base_image=$existing_image
  note "[skip] $base_image is present"
else
  base_image="dormice-base:$(date +%Y%m%d)"
  if [ "$MIRROR" = cn ] && ! docker image inspect ubuntu:24.04 >/dev/null 2>&1; then
    # Personal registry mirrors in mainland China often proxy only an image
    # whitelist; daocloud + retag is the measured workaround.
    docker pull -q docker.m.daocloud.io/library/ubuntu:24.04
    docker tag docker.m.daocloud.io/library/ubuntu:24.04 ubuntu:24.04
    docker rmi -f docker.m.daocloud.io/library/ubuntu:24.04 >/dev/null
  fi
  if [ "$MIRROR" = cn ]; then
    # http on purpose: the base image has no CA certificates until this very
    # layer installs them, so an https mirror cannot even handshake. apt's
    # integrity comes from GPG signatures, not TLS (the default
    # archive.ubuntu.com is http too).
    docker build -t "$base_image" \
      --build-arg UBUNTU_MIRROR=http://mirrors.aliyun.com/ubuntu/ \
      --build-arg NODE_DIST=https://npmmirror.com/mirrors/node \
      --build-arg PIP_INDEX=https://mirrors.aliyun.com/pypi/simple/ \
      --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
      "$INSTALL_DIR/images"
  else
    docker build -t "$base_image" "$INSTALL_DIR/images"
  fi
  note "built $base_image from images/Dockerfile"
fi
# The seed, appended once to an existing gateway.env too (a column born
# after the row: the gateway fills its settings from this while empty,
# and the console edits it from then on).
if ! grep -q '^DORMICE_BASE_IMAGE=' "$GATEWAY_ENV_FILE"; then
  {
    echo "# The fleet's base image (the image template-less sandboxes boot from);"
    echo '# a first-boot seed — the console edits the value in force.'
    echo "DORMICE_BASE_IMAGE=$base_image"
  } >>"$GATEWAY_ENV_FILE"
  note "added DORMICE_BASE_IMAGE=$base_image to $GATEWAY_ENV_FILE (the fleet's setting from here on)"
fi
fi

# ---- image registry (gateway's machine) --------------------------------------
# The fleet's one image store (design record #33): a node that lacks an
# image pulls it from here — the base image install.sh pushes below, the
# template images the operator pushes. TLS with a self-signed certificate
# and the fleet token as the password (user `dormice`, bcrypt htpasswd):
# not a preference — a registry over plain HTTP cannot take basic auth
# at all (the distribution documentation says so), so the choice is TLS
# with a lock or no lock, and a store that decides what code every node
# runs gets the lock (design record #34 draws the fleet's one credential;
# this is the same one, no second secret). Docker on this machine trusts
# the certificate through /etc/docker/certs.d — picked up per pull, no
# dockerd restart — and a node copies the same file when it joins.
if [ "$ROLE" = gateway ]; then
log "image registry (distribution v$REGISTRY_VERSION)"
if [ -x /usr/local/bin/registry ] && /usr/local/bin/registry --version 2>/dev/null | grep -q "v$REGISTRY_VERSION\b"; then
  note "[skip] registry v$REGISTRY_VERSION is installed"
else
  registry_url="https://github.com/distribution/distribution/releases/download/v$REGISTRY_VERSION/registry_${REGISTRY_VERSION}_linux_amd64.tar.gz"
  [ "$MIRROR" = cn ] && registry_url="https://ghfast.top/$registry_url"
  curl -fsSL -o /tmp/registry.tar.gz "$registry_url"
  echo "$REGISTRY_SHA256  /tmp/registry.tar.gz" | sha256sum -c - >/dev/null
  tar -C /tmp -xzf /tmp/registry.tar.gz registry
  install -m 755 /tmp/registry /usr/local/bin/registry
  rm -f /tmp/registry.tar.gz /tmp/registry
  note "installed registry v$REGISTRY_VERSION to /usr/local/bin"
fi
# Where it listens and where the nodes pull from: the flag, else what the
# gateway's env already says (re-runs), else the address this machine
# speaks to the world from (the default route's source — on a cloud VPC
# the private address the other machines reach it by; docker0's 172.17.0.1
# never is). A machine whose main address is public listens on it; the
# lock is what makes that acceptable.
# (A flag contradicting the env line died at the top, with the other fleet
# flags.)
env_registry_addr=$(sed -n 's/^DORMICE_REGISTRY_ADDRESS=//p' "$GATEWAY_ENV_FILE" | head -1)
REGISTRY_ADDR=${REGISTRY_ADDR_FLAG:-$env_registry_addr}
if [ -z "$REGISTRY_ADDR" ]; then
  registry_host=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')
  [ -n "$registry_host" ] || registry_host=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$registry_host" ] || die "cannot tell this machine's address for the registry to listen on — pass --registry-addr <address>:$REGISTRY_PORT"
  REGISTRY_ADDR="$registry_host:$REGISTRY_PORT"
fi
registry_host=${REGISTRY_ADDR%:*}
# The SAN as openssl req takes it, and as openssl x509 prints it back.
case "$registry_host" in
  *[!0-9.]*) registry_san="DNS:$registry_host"; registry_san_printed="DNS:$registry_host" ;;
  *) registry_san="IP:$registry_host"; registry_san_printed="IP Address:$registry_host" ;;
esac
install -d -m 700 "$REGISTRY_CONF_DIR" "$REGISTRY_DIR"
# The certificate: ten years, SAN = the registry's address, its own CA
# (self-signed). Regenerated when the address moved out of its SAN.
if [ -f "$REGISTRY_CONF_DIR/tls.crt" ] && openssl x509 -in "$REGISTRY_CONF_DIR/tls.crt" -noout -ext subjectAltName 2>/dev/null | grep -q "$registry_san_printed"; then
  note "[skip] certificate for $registry_san is in place"
else
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$REGISTRY_CONF_DIR/tls.key" -out "$REGISTRY_CONF_DIR/tls.crt" \
    -subj '/CN=dormice-registry' -addext "subjectAltName=$registry_san" >/dev/null 2>&1
  chmod 600 "$REGISTRY_CONF_DIR/tls.key"
  note "issued a self-signed certificate for $registry_san (10 years) — sha256 $(openssl x509 -in "$REGISTRY_CONF_DIR/tls.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
fi
# The lock: user dormice, password the fleet token, bcrypt (the only hash
# the registry's htpasswd takes). caddy hashes it — reading the plaintext
# from stdin, never a command line. Written once: the token never rotates.
if [ -f "$REGISTRY_CONF_DIR/htpasswd" ]; then
  note '[skip] htpasswd is in place'
else
  command -v caddy >/dev/null || die 'caddy is needed to hash the registry password (caddy hash-password) — the ingress step above did not install it because port 80 is taken; install caddy by hand or free port 80, then re-run'
  hashed=$(printf '%s\n' "$API_TOKEN" | caddy hash-password 2>/dev/null)
  case "$hashed" in
    \$2*) ;;
    *) die 'caddy hash-password did not produce a bcrypt hash — is caddy >= 2.4?' ;;
  esac
  printf 'dormice:%s\n' "$hashed" >"$REGISTRY_CONF_DIR/htpasswd"
  chmod 600 "$REGISTRY_CONF_DIR/htpasswd"
  note "wrote $REGISTRY_CONF_DIR/htpasswd (user dormice, password = the fleet token)"
fi
registry_conf=$(cat <<EOF
# Written by Dormice install.sh — rewritten on every run.
version: 0.1
log:
  level: warn
storage:
  filesystem:
    rootdirectory: $REGISTRY_DIR
  delete:
    enabled: true
http:
  addr: $REGISTRY_ADDR
  tls:
    certificate: $REGISTRY_CONF_DIR/tls.crt
    key: $REGISTRY_CONF_DIR/tls.key
auth:
  htpasswd:
    realm: dormice-registry
    path: $REGISTRY_CONF_DIR/htpasswd
EOF
)
REGISTRY_CHANGED=''
if [ "$(cat "$REGISTRY_CONF_DIR/registry.yml" 2>/dev/null)" = "$registry_conf" ]; then
  note "[skip] registry.yml is in place (listening on $REGISTRY_ADDR)"
else
  printf '%s\n' "$registry_conf" >"$REGISTRY_CONF_DIR/registry.yml"
  REGISTRY_CHANGED=1
  note "wrote $REGISTRY_CONF_DIR/registry.yml (listening on $REGISTRY_ADDR, TLS, htpasswd)"
fi
if ! cmp -s "$INSTALL_DIR/deploy/dormice-registry.service" /etc/systemd/system/dormice-registry.service; then
  cp "$INSTALL_DIR/deploy/dormice-registry.service" /etc/systemd/system/dormice-registry.service
  systemctl daemon-reload
  REGISTRY_CHANGED=1
fi
systemctl enable dormice-registry >/dev/null 2>&1
if [ -n "$REGISTRY_CHANGED" ] || [ "$(systemctl is-active dormice-registry)" != active ]; then
  systemctl restart dormice-registry
fi
# Docker's trust in the certificate: the file's presence is the whole
# mechanism — no daemon.json edit, no restart.
install -d "/etc/docker/certs.d/$REGISTRY_ADDR"
if ! cmp -s "$REGISTRY_CONF_DIR/tls.crt" "/etc/docker/certs.d/$REGISTRY_ADDR/ca.crt"; then
  install -m 644 "$REGISTRY_CONF_DIR/tls.crt" "/etc/docker/certs.d/$REGISTRY_ADDR/ca.crt"
  note "trusted the certificate for docker: /etc/docker/certs.d/$REGISTRY_ADDR/ca.crt"
fi
for _ in $(seq 1 40); do
  registry_code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$REGISTRY_CONF_DIR/tls.crt" "https://$REGISTRY_ADDR/v2/" 2>/dev/null || true)
  [ "$registry_code" = 401 ] && break
  sleep 0.5
done
[ "$registry_code" = 401 ] \
  || die "the registry did not answer on https://$REGISTRY_ADDR/v2/ (got '${registry_code:-nothing}', expected 401 asking for the credential) — check: journalctl -u dormice-registry -n 50"
note "registry is answering on https://$REGISTRY_ADDR (TLS, asks for the fleet credential)"
if ! grep -q '^DORMICE_REGISTRY_ADDRESS=' "$GATEWAY_ENV_FILE"; then
  {
    echo "# The fleet's image registry (host:port), run by this machine's"
    echo '# dormice-registry unit: nodes pull the images they lack from here.'
    echo "DORMICE_REGISTRY_ADDRESS=$REGISTRY_ADDR"
  } >>"$GATEWAY_ENV_FILE"
  note "added DORMICE_REGISTRY_ADDRESS=$REGISTRY_ADDR to $GATEWAY_ENV_FILE"
fi
# The base image into the store, once per tag (a manifest already there
# is skipped). Template images are the operator's to push — templates.mdx
# has the three lines; the registry credential is the fleet token.
manifest_code=$(curl_basic_config | curl -s -K - -o /dev/null -w '%{http_code}' --cacert "$REGISTRY_CONF_DIR/tls.crt" \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json' \
  "https://$REGISTRY_ADDR/v2/${base_image%:*}/manifests/${base_image##*:}" 2>/dev/null || true)
if [ "$manifest_code" = 200 ]; then
  note "[skip] $base_image is in the registry"
else
  printf '%s' "$API_TOKEN" | docker login "$REGISTRY_ADDR" -u dormice --password-stdin >/dev/null 2>&1 \
    || die "docker login to https://$REGISTRY_ADDR refused the fleet credential — if the token changed after $REGISTRY_CONF_DIR/htpasswd was written, delete that file and re-run"
  docker tag "$base_image" "$REGISTRY_ADDR/$base_image"
  # The credential does not stay in /root/.docker/config.json, whatever
  # the push comes to: the daemon presents it per pull from memory, and a
  # push that fails must not leave the fleet token on disk (`set -e` would
  # exit before a logout that only followed success; found by review,
  # 2026-09-15).
  if ! docker push -q "$REGISTRY_ADDR/$base_image" >/dev/null; then
    docker logout "$REGISTRY_ADDR" >/dev/null 2>&1 || true
    die "docker push of $REGISTRY_ADDR/$base_image failed — the registry's side of it: journalctl -u dormice-registry -n 50; fix the cause and re-run"
  fi
  docker logout "$REGISTRY_ADDR" >/dev/null 2>&1 || true
  note "pushed $base_image to the registry as $REGISTRY_ADDR/$base_image"
fi
fi

# ---- joining the fleet (node machine) ----------------------------------------
# What a node needs from its gateway before its daemon starts: the fleet
# registry's certificate, pinned into Docker's trust store on first sight
# (the ssh posture: the fingerprint is printed, and an intranet
# man-in-the-middle at install time is outside the threat model of design
# record #34), and the base image pulled ahead so `dor doctor`'s container
# probes have it — the daemon would pull it on its own at its first
# bundle, but a minute later, in the background.
if [ "$ROLE" = node ]; then
log "joining the fleet at $GATEWAY_URL"
fleet_config=$(curl_auth_config | curl -fsS -K - -X POST -H 'content-type: application/json' -d '{}' "$GATEWAY_URL/getConfig" 2>/dev/null) \
  || die "the gateway at $GATEWAY_URL did not answer getConfig — is it running; is that address its machine's Caddy on :80 (the gateway itself listens on loopback only, so http://<gateway machine>:$GATEWAY_PORT answers no other machine); is :80 there open to this machine; is DORMICE_API_TOKEN the gateway machine's token? (curl -fsS $GATEWAY_URL/healthz answers without a token)"
read -r FLEET_REGISTRY FLEET_BASE_IMAGE <<EOF
$(printf '%s' "$fleet_config" | node -e '
const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log((c.settings.registryAddress ?? "-") + " " + (c.settings.baseImage ?? "-"));
')
EOF
note "the fleet's registry: ${FLEET_REGISTRY}; base image: ${FLEET_BASE_IMAGE}"
if [ "$FLEET_REGISTRY" != - ]; then
  cert_dir="/etc/docker/certs.d/$FLEET_REGISTRY"
  if [ -f "$cert_dir/ca.crt" ]; then
    note "[skip] the registry's certificate is pinned at $cert_dir/ca.crt"
  else
    install -d "$cert_dir"
    openssl s_client -showcerts -connect "$FLEET_REGISTRY" -servername "${FLEET_REGISTRY%:*}" </dev/null 2>/dev/null \
      | openssl x509 -outform PEM >"$cert_dir/ca.crt" 2>/dev/null \
      || die "could not fetch the registry's certificate from https://$FLEET_REGISTRY — is :${FLEET_REGISTRY##*:} on the gateway machine open to this machine?"
    [ -s "$cert_dir/ca.crt" ] || die "https://$FLEET_REGISTRY presented no certificate"
    note "pinned the registry's certificate on first sight: $cert_dir/ca.crt — sha256 $(openssl x509 -in "$cert_dir/ca.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
    note "compare it with the gateway machine's: openssl x509 -in $REGISTRY_CONF_DIR/tls.crt -noout -fingerprint -sha256"
  fi
  registry_code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$cert_dir/ca.crt" "https://$FLEET_REGISTRY/v2/" 2>/dev/null || true)
  [ "$registry_code" = 401 ] || die "the registry at https://$FLEET_REGISTRY did not answer as expected (got '${registry_code:-nothing}', expected 401 asking for the credential)"
  if [ "$FLEET_BASE_IMAGE" != - ]; then
    if docker image inspect "$FLEET_BASE_IMAGE" >/dev/null 2>&1; then
      note "[skip] base image $FLEET_BASE_IMAGE is present"
    else
      printf '%s' "$API_TOKEN" | docker login "$FLEET_REGISTRY" -u dormice --password-stdin >/dev/null 2>&1 \
        || die "docker login to https://$FLEET_REGISTRY refused the fleet credential — DORMICE_API_TOKEN here must be the gateway machine's token"
      if ! docker pull -q "$FLEET_REGISTRY/$FLEET_BASE_IMAGE" >/dev/null; then
        # Logged out on failure too: the fleet token must not stay on disk.
        docker logout "$FLEET_REGISTRY" >/dev/null 2>&1 || true
        die "could not pull $FLEET_REGISTRY/$FLEET_BASE_IMAGE — on the gateway machine, re-run install.sh (it pushes the base image), then re-run here"
      fi
      docker tag "$FLEET_REGISTRY/$FLEET_BASE_IMAGE" "$FLEET_BASE_IMAGE"
      docker logout "$FLEET_REGISTRY" >/dev/null 2>&1 || true
      note "pulled the fleet's base image $FLEET_BASE_IMAGE from the registry"
    fi
  fi
elif [ "$FLEET_BASE_IMAGE" != - ] && ! docker image inspect "$FLEET_BASE_IMAGE" >/dev/null 2>&1; then
  note "WARNING: the fleet has no registry and this machine lacks the base image $FLEET_BASE_IMAGE — build or load it here under that name before creating sandboxes"
fi
fi

# ---- backups (before anything restarts) --------------------------------------
# A copy of every database this run may migrate, taken through SQLite's
# online backup API (a consistent snapshot even while the daemon writes;
# the hosts have no sqlite3 CLI), before any unit is restarted: the new
# daemon migrates its ledger forward at boot, and a downgrade past a
# migration is not a one-click affair. Three kept, the oldest dropped.
log 'backups'
backup_db() { # <source db> <destination dir>
  [ -f "$1" ] || return 0
  mkdir -p "$2"
  (cd "$INSTALL_DIR/packages/server" && node -e '
const Database = require("better-sqlite3");
const [src, dst] = process.argv.slice(1);
const db = new Database(src, { readonly: true });
db.backup(dst).then(() => { db.close(); }).catch((err) => { console.error(err.message); process.exit(1); });
' "$1" "$2/$(basename "$1")") || die "backup of $1 failed"
  chmod 600 "$2/$(basename "$1")"
}
BACKUP_DIR="$DATA_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)-${OLD_SHA:-fresh}"
backed=''
if [ -f "$DATA_DIR/dormice.db" ]; then
  backup_db "$DATA_DIR/dormice.db" "$BACKUP_DIR"
  backed="$backed dormice.db"
fi
if [ "$ROLE" = gateway ] && [ -f "$GATEWAY_DATA_DIR/gateway.db" ]; then
  backup_db "$GATEWAY_DATA_DIR/gateway.db" "$BACKUP_DIR"
  backed="$backed gateway.db"
fi
if [ -n "$backed" ]; then
  chmod 700 "$BACKUP_DIR"
  note "backed up$backed to $BACKUP_DIR"
  # shellcheck disable=SC2012 # ls sorts the timestamped names; the directory is ours
  ls -1d "$DATA_DIR"/backups/*/ 2>/dev/null | sort | head -n -3 | while read -r old; do
    rm -rf "$old"
    note "dropped old backup $old"
  done
else
  note '[skip] no database yet — a first install has nothing to back up'
fi

# ---- the old ledger's configuration into the gateway (once) ------------------
# A machine that ran as a single daemon before the gateway existed holds
# the fleet's configuration in its ledger — the S3 store, the default
# policy, the domain aliases, the templates, the API keys, the console
# account — and it must be in the gateway's database BEFORE the gateway's
# first start: at that start the gateway seeds its settings from the env
# and the daemon takes that at its first check-in, and months of operator
# settings would be quietly gone (a restore from archive would fail, a
# template sandbox would wake to "not registered"). The import is the
# gateway package's own tool (import-ledger.ts has the translation); a
# failure here ends the run before any unit restarts, with the ledger
# untouched.
if [ "$ROLE" = gateway ]; then
log 'importing the single-machine ledger into the gateway'
# The file is the pre-check only — a running gateway holds the lock the
# tool would need, and a gateway that has started has its row; the tool's
# own refusal, on the settings row, is the arbiter (import-ledger.ts).
if [ -f "$GATEWAY_DATA_DIR/gateway.db" ]; then
  note '[skip] the gateway database exists — the import is for its first start'
elif [ ! -f "$DATA_DIR/dormice.db" ]; then
  note '[skip] no daemon ledger — a fresh install has nothing to import'
else
  has_settings=$(cd "$INSTALL_DIR/packages/server" && node -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true });
try { console.log(db.prepare("SELECT count(*) AS n FROM runtime_settings").get().n); } catch { console.log(0); }
db.close();
' "$DATA_DIR/dormice.db")
  if [ "$has_settings" = 0 ]; then
    note '[skip] the daemon ledger holds no settings row — nothing to import'
  else
    imported=$(
      set -a
      # shellcheck source=/dev/null
      . "$GATEWAY_ENV_FILE"
      set +a
      node "$INSTALL_DIR/packages/gateway/dist/import.js" --node-db "$DATA_DIR/dormice.db" --node-env "$ENV_FILE"
    ) || {
      # The tool creates the gateway database (its migrations) before it
      # reads the ledger, so a failure past that point leaves a file with
      # tables and no settings row. Left there, a re-run would see the
      # file above and skip the import, the gateway would seed its
      # settings from the env, and the daemon's next boot would drop the
      # tables the import carries — the operator's keys and console
      # account gone with no word said (found by review, 2026-09-15). The
      # file did not exist before this step: removing it puts the machine
      # back exactly where it was, and the re-run imports again.
      rm -f "$GATEWAY_DATA_DIR/gateway.db" "$GATEWAY_DATA_DIR/gateway.db-wal" "$GATEWAY_DATA_DIR/gateway.db-shm" "$GATEWAY_DATA_DIR/gateway.db.lock" "$GATEWAY_DATA_DIR/gateway.db.lock-journal"
      die "the import of $DATA_DIR/dormice.db into the gateway failed — nothing was restarted, and the half-made gateway database was removed so that the re-run imports again; fix the cause and re-run"
    }
    note "imported into the gateway: $imported"
  fi
fi
fi

# ---- systemd services --------------------------------------------------------
# The gateway's machine: two units, the gateway first — a daemon without a
# configuration copy takes its first bundle from its gateway before it
# listens, and a re-run just built both dists: the two processes of a
# fleet of one run one commit, never two. A node machine: the daemon
# alone, joined to its remote gateway. Restarted, not merely started: all
# crash-only by design, so restarting them is always safe.
log 'systemd services'
cp "$INSTALL_DIR/deploy/dormice.service" /etc/systemd/system/dormice.service
if [ "$ROLE" = gateway ]; then
  cp "$INSTALL_DIR/deploy/dormice-gateway.service" /etc/systemd/system/dormice-gateway.service
  systemctl daemon-reload
  systemctl enable dormice-gateway dormice >/dev/null 2>&1
  # The daemon goes down first and comes up last: this machine's two
  # processes upgrade as one. Gateway first with the old daemon still
  # running, the old daemon's check-in could land on the new gateway in
  # the second or two before its own restart — read as a node behind, told
  # to upgrade, it would try to start the very install.sh unit that is
  # running, log the refusal, and hold the fleet's one-at-a-time slot for
  # an interval (found by review, 2026-09-15). Stopped, it says nothing
  # until it is the new build.
  systemctl stop dormice
  systemctl restart dormice-gateway
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$GATEWAY_PORT/healthz" >/dev/null 2>&1 && break
    sleep 0.5
  done
  if ! curl -fsS "http://127.0.0.1:$GATEWAY_PORT/healthz" >/dev/null 2>&1; then
    # The daemon must not stay down for the gateway's failure: it serves
    # its sandboxes without one, and its check-in keeps trying.
    systemctl start dormice
    die "the gateway did not answer /healthz on 127.0.0.1:$GATEWAY_PORT — check: journalctl -u dormice-gateway -n 50 (the daemon was started again; on this machine's first run with a gateway it holds no configuration copy yet and waits for the gateway before it listens)"
  fi
  note "gateway is answering on 127.0.0.1:$GATEWAY_PORT"
  if [ -n "$CADDY_REPOINT_PENDING" ]; then
    # The re-point deferred from the ingress step: the gateway answers and
    # the daemon is stopped, so the daemon's port is dark either way — the
    # door changes hands inside the restart this run costs anyway. A
    # gateway that did not come up (above) leaves the door on the daemon,
    # which was started again and keeps serving.
    sed -i "s|reverse_proxy 127.0.0.1:$PORT\b|reverse_proxy 127.0.0.1:$GATEWAY_PORT|g" "$ingress_target"
    # shellcheck disable=SC2086 # the reload command is the operator's own words, split on purpose
    (cd / && $ingress_reload >/dev/null 2>&1) || systemctl restart caddy
    note "re-pointed $ingress_target from the daemon ($PORT) to the gateway ($GATEWAY_PORT) and reloaded caddy — the console lives there now"
  fi
  systemctl start dormice
  note 'enabled and (re)started both'
else
  systemctl daemon-reload
  systemctl enable dormice >/dev/null 2>&1
  systemctl restart dormice
  note 'enabled and (re)started the daemon'
fi

# ---- verification: the install has not succeeded until doctor says so --------
log 'verification'
# 120s, not the 10s this probe once was: startup does migrations, the
# startup guard, and a fleet-sized reconciliation before it listens, so a
# busy production ledger takes well past 10s (2026-07-31, ~21s measured on
# a live fleet — the 10s probe declared a SUCCEEDED upgrade failed, and a
# false "failed" verdict is the one thing this step must never produce).
# Breaking on the first answer keeps the fresh-install case as fast as ever.
for _ in $(seq 1 240); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 \
  || die "the daemon did not answer /healthz on 127.0.0.1:$PORT — check: journalctl -u dormice -n 50 (a daemon with no configuration copy waits for its gateway before it listens)"
note "daemon is answering on 127.0.0.1:$PORT"
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
if [ "$ROLE" = gateway ]; then
  # Both env files: doctor reads the node's knobs from the daemon's and the
  # fleet's seeds (the base image, the S3 set, the registry, the managed
  # front door) from the gateway's.
  # shellcheck source=/dev/null
  . "$GATEWAY_ENV_FILE"
else
  # A node's env names no image and no registry — the fleet's, learned
  # from the gateway above — so doctor is told them for this run alone.
  [ "$FLEET_BASE_IMAGE" != - ] && export DORMICE_BASE_IMAGE=$FLEET_BASE_IMAGE
  [ "$FLEET_REGISTRY" != - ] && export DORMICE_REGISTRY_ADDRESS=$FLEET_REGISTRY
fi
set +a
dor doctor

# Written only now: succeeded means what it says — the daemon restarted on
# the new code AND doctor proved the install whole, not merely "the script
# reached the end".
status_write succeeded

printf '\nDormice is installed.\n'
if [ "$ROLE" = node ]; then
  printf '  role:         node %s of gateway %s, reached at %s\n' "$(sed -n 's/^DORMICE_NODE_ID=//p' "$ENV_FILE")" "$GATEWAY_URL" "$(sed -n 's/^DORMICE_NODE_ENDPOINT=//p' "$ENV_FILE")"
  printf '  daemon logs:  journalctl -u dormice -f\n'
  printf '  the fleet is driven from its gateway: console, keys, settings, templates, upgrades all answer there.\n'
  printf '  cloud firewall: allow :80 on this machine from the gateway machine only.\n'
  exit 0
fi
printf '  API token:    grep ^DORMICE_API_TOKEN %s\n' "$ENV_FILE"
printf '  gateway logs: journalctl -u dormice-gateway -f   (the door: console, keys, settings, templates)\n'
printf '  daemon logs:  journalctl -u dormice -f           (the node: sandboxes)\n'
printf '  registry:     https://%s (TLS, user dormice, password = the API token; journalctl -u dormice-registry -f)\n' "$REGISTRY_ADDR"
printf '  CLI:          export DORMICE_ENDPOINT=http://127.0.0.1:%s DORMICE_API_TOKEN=<token>; dor sandbox ls\n' "$GATEWAY_PORT"
printf '                (the gateway is the door for every verb; a node answers only the sandbox and host verbs\n'
printf '                for itself on 127.0.0.1:%s)\n' "$PORT"
printf '  Both processes listen on 127.0.0.1 only, by design — exposing them is a reverse proxy'"'"'s job.\n'
printf '  add a node:   on another machine of the same network, with :80 (Caddy, the gateway'"'"'s door) and :%s here\n' "$REGISTRY_PORT"
printf '                open to it and its own :80 open to this machine:\n'
printf '                export DORMICE_API_TOKEN=<token>; bash install.sh --role node --gateway http://%s:80\n' "${REGISTRY_ADDR%:*}"
if [ "$(systemctl is-active caddy 2>/dev/null)" = active ]; then
  printf '  console:      http://<this-host-ip>/console (Caddy on :80 -> the gateway; open your cloud firewall for\n'
  printf '                80/443, then bind domains in the domains page for automatic HTTPS)\n'
fi
