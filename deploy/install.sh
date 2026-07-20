#!/usr/bin/env bash
# Dormice installer: turns a bare Ubuntu/Debian x86_64 host into a running
# Dormice daemon, then proves it by running `dor doctor`.
#
#   curl -fsSL https://raw.githubusercontent.com/BitMiracle-AI/Dormice/main/deploy/install.sh | bash
#
# Flags (pass after `bash -s --` when piping):
#   --mirror cn     use mainland-China mirrors for every download
#   --swap-gb N     size of the swapfile to create when the host has no swap
#                   (default 16 — the configuration freezing was measured on)
#   --status-dir D  write status.json into D as the run progresses — how the
#                   daemon's one-click upgrade reads the outcome back; a
#                   manual run doesn't need it
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

REPO_URL=https://github.com/BitMiracle-AI/Dormice.git
INSTALL_DIR=/opt/dormice
ENV_FILE=/etc/dormice/env
DATA_DIR=/var/lib/dormice
DAEMON_JSON=/etc/docker/daemon.json
PORT=3676

# ---- flags -----------------------------------------------------------------
MIRROR=''
SWAP_GB=16
STATUS_DIR=''
while [ $# -gt 0 ]; do
  case "$1" in
    --mirror) MIRROR="${2:?--mirror needs a value}"; shift 2 ;;
    --mirror=*) MIRROR="${1#*=}"; shift ;;
    --swap-gb) SWAP_GB="${2:?--swap-gb needs a value}"; shift 2 ;;
    --swap-gb=*) SWAP_GB="${1#*=}"; shift ;;
    --status-dir) STATUS_DIR="${2:?--status-dir needs a value}"; shift 2 ;;
    --status-dir=*) STATUS_DIR="${1#*=}"; shift ;;
    *) echo "install.sh: unknown flag $1 (known: --mirror cn, --swap-gb N, --status-dir D)" >&2; exit 1 ;;
  esac
done
if [ -n "$MIRROR" ] && [ "$MIRROR" != cn ]; then
  echo "install.sh: --mirror only knows \"cn\", got \"$MIRROR\"" >&2
  exit 1
fi

# log() doubles as the phase tracker: when something fails under `set -e`
# there is no message to report, but "which step" is always known.
PHASE='startup'
log()  { PHASE="$*"; printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
DIE_MSG=''
die()  { DIE_MSG="$*"; printf '\ninstall.sh: %s\n' "$*" >&2; exit 1; }

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
log 'base packages (git, curl, openssl, zstd)'
missing=''
# zstd: the archiver's tar -I zstd runs on the host at every archive/restore.
for tool in git curl openssl zstd; do
  command -v "$tool" >/dev/null || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  apt-get update -q
  # shellcheck disable=SC2086 # word splitting is the point
  apt-get install -qy ca-certificates $missing
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
log 'Docker'
if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  note "[skip] dockerd $(docker version --format '{{.Server.Version}}') is running"
else
  curl -fsSL -o /tmp/get-docker.sh https://get.docker.com
  if [ "$MIRROR" = cn ]; then
    sh /tmp/get-docker.sh --mirror Aliyun
  else
    sh /tmp/get-docker.sh
  fi
  rm /tmp/get-docker.sh
  systemctl enable --now docker
  note "installed dockerd $(docker version --format '{{.Server.Version}}')"
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
  /usr/local/bin/runsc install
  systemctl restart docker
  note "installed $(runsc --version | head -1), registered with Docker"
fi

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
log 'kernel parameters (vm.swappiness = 100, net.ipv4.ip_forward = 1)'
SYSCTL_FILE=/etc/sysctl.d/99-dormice.conf
sysctl_wanted='# Managed by Dormice install.sh — rewritten on every run.
vm.swappiness=100
net.ipv4.ip_forward=1'
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
  [ "${winner#*|}" = "$want" ] \
    || die "$key must be $want at boot, but the sysctl boot order ends with ${winner%%|*} setting it to ${winner#*|} — change or remove that line, then re-run"
  # procps `sysctl --system` (other installers run it) applies
  # /etc/sysctl.conf after every sysctl.d file, symlink or not — a
  # disagreeing value there overrides us at the very next replay even when
  # the systemd boot order ends with ours.
  if [ -f /etc/sysctl.conf ]; then
    conf_value=$(sysctl_winner "$key" /etc/sysctl.conf)
    conf_value=${conf_value#*|}
    [ -z "$conf_value" ] || [ "$conf_value" = "$want" ] \
      || die "$key must be $want, but /etc/sysctl.conf sets it to $conf_value — procps sysctl --system applies that file last, so the next config replay overrides us; change or remove that line, then re-run"
  fi
done
note 'verified: both keys survive the sysctl boot order and a procps sysctl --system replay'

# ---- cloud metadata firewall -------------------------------------------------
# Sandboxes run untrusted code; on a cloud host with an attached role, one
# curl to the metadata service steals live credentials. gVisor blocks kernel
# attack surface, not network reachability — this must be firewalled.
log 'cloud metadata firewall (DOCKER-USER chain)'
docker_user=$(iptables -S DOCKER-USER 2>/dev/null) \
  || die 'the DOCKER-USER chain is missing — is dockerd running?'
added=''
for target in 169.254.0.0/16 100.100.100.200; do
  if ! printf '%s\n' "$docker_user" | grep -q -- "-d ${target%/*}\(/[0-9]*\)\? .*-j DROP"; then
    iptables -I DOCKER-USER -d "$target" -j DROP
    added="$added $target"
  fi
done
if [ -n "$added" ]; then note "added DROP rules:$added"; else note '[skip] both DROP rules present'; fi
# Persistence is our own oneshot unit that re-adds the rules after docker
# creates the DOCKER-USER chain at boot (docker never flushes that chain
# afterwards). Deliberately NOT iptables-persistent: installing it makes apt
# remove ufw (the packages conflict) — silently discarding an operator's
# firewall — and `netfilter-persistent save` snapshots the whole ruleset,
# operator rules and Docker's ephemeral NAT entries included, when exactly
# two rules are ours to persist. Hosts persisted the old way keep their
# /etc/iptables/rules.v4 untouched; the -C checks make duplicates impossible.
FIREWALL_UNIT=/etc/systemd/system/dormice-metadata-firewall.service
firewall_unit=$(cat <<'EOF'
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
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -d 169.254.0.0/16 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 169.254.0.0/16 -j DROP'
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -d 100.100.100.200 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 100.100.100.200 -j DROP'

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
systemctl enable dormice-metadata-firewall >/dev/null 2>&1
# Started now, not only at boot: a unit that has never run is an unproven
# promise, and the start is a no-op when the rules are already in.
systemctl restart dormice-metadata-firewall

# ---- Dormice code -----------------------------------------------------------
# Defined before the pull so the rollback in on_exit can always call it.
# Deps then build, from a clean tree at whatever commit is checked out —
# the same path for the fresh install, the upgrade, and the rollback.
build_repo() {
  cd "$INSTALL_DIR"
  if [ "$MIRROR" = cn ]; then
    npm_config_registry=https://registry.npmmirror.com pnpm install --frozen-lockfile
  else
    pnpm install --frozen-lockfile
  fi
  # Build only what a daemon host runs: the server (plus its workspace deps),
  # the CLI, and the console SPA. The website package is the project's Next.js
  # marketing site — building it here would cost minutes and import a frontend
  # toolchain's failure modes into an installer whose job is the daemon.
  pnpm --filter "@dormice/server..." --filter "@dormice/cli..." --filter "@dormice/console" build
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

# ---- sandbox base image ------------------------------------------------------
log 'sandbox base image'
existing_image=''
[ -f "$ENV_FILE" ] && existing_image=$(sed -n 's/^DORMICE_BASE_IMAGE=//p' "$ENV_FILE")
if [ -n "$existing_image" ] && docker image inspect "$existing_image" >/dev/null 2>&1; then
  base_image=$existing_image
  note "[skip] $base_image (from $ENV_FILE) is present"
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

# ---- ingress (Caddy reverse proxy) -------------------------------------------
# The daemon binds 127.0.0.1 by design; Caddy on :80 is what makes
# http://<host-ip>/console reachable from a browser. The Caddyfile below is
# also what the daemon rewrites when the operator binds a domain in the
# console (setIngress) — Caddy then obtains and renews the TLS certificate
# on its own. Pinned binary with checksum, same posture as gVisor.
log 'ingress (Caddy reverse proxy)'
CADDY_VERSION=2.10.0
CADDY_SHA512=626682d623ca04356ab3c9a93a82386cfde6d8243b11f2d0eea9e97ba630c7ada62373401e96b72c6690c98ae8dd004d61fafe477f5249690d5cb251ebbfd2d9
CADDYFILE=/etc/caddy/Caddyfile
if command -v caddy >/dev/null; then
  note "[skip] caddy is installed ($(caddy version | cut -d' ' -f1))"
elif ss -ltnH 'sport = :80' 2>/dev/null | grep -q .; then
  # Another server owns port 80: never fight it. The operator keeps their
  # proxy (point it at 127.0.0.1:$PORT); web domain binding stays off.
  note "port 80 is already in use and caddy is not installed — skipping the ingress layer"
  note "point your own reverse proxy at 127.0.0.1:$PORT; the console's domain binding stays disabled"
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
if command -v caddy >/dev/null; then
  mkdir -p /etc/caddy
  if [ ! -f "$CADDYFILE" ]; then
    # The marker below is the ownership contract: the daemon refuses to
    # rewrite a Caddyfile that lacks it. Kept in sync by hand with
    # packages/server/src/ingress.ts.
    cat >"$CADDYFILE" <<EOF
# Managed by Dormice — setIngress rewrites this file.

:80 {
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
    note "wrote $CADDYFILE (plain HTTP on :80 — bind domains in the console's domains page for HTTPS)"
    INGRESS_FILE_READY=1
  elif grep -q 'Managed by Dormice' "$CADDYFILE"; then
    note "[skip] $CADDYFILE is managed by Dormice — left to the daemon"
    INGRESS_FILE_READY=1
  else
    note "$CADDYFILE exists but was not written by Dormice — left untouched; domain binding will refuse to overwrite it"
    INGRESS_FILE_READY=1
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
log "daemon configuration ($ENV_FILE)"
install -d -m 700 "$DATA_DIR"
if [ -f "$ENV_FILE" ]; then
  note "[skip] exists — kept as is (your API token is never rotated); delete it to regenerate"
else
  install -d -m 755 /etc/dormice
  # No inline comments below: systemd's EnvironmentFile takes the whole line
  # as the value. Full-line comments are fine.
  cat >"$ENV_FILE" <<EOF
# Dormice daemon configuration, read by systemd (EnvironmentFile).
# Full-line comments only — an inline comment becomes part of the value.
# All knobs and defaults: packages/server/src/config.ts
DORMICE_API_TOKEN=$(openssl rand -hex 32)
DORMICE_EXECUTOR=docker
DORMICE_BASE_IMAGE=$base_image
DORMICE_DB_PATH=$DATA_DIR/dormice.db
DORMICE_DATA_DIR=$DATA_DIR
# Optional: the S3 archiver. Set all four to archive idle sandboxes' disks
# to any S3-compatible store (AWS, R2, MinIO, OSS in S3-compat mode) after
# a week of idleness — and restore them on the next acquire. Endpoint is a
# full URL; MinIO needs DORMICE_S3_FORCE_PATH_STYLE=true.
#DORMICE_S3_ENDPOINT=
#DORMICE_S3_BUCKET=
#DORMICE_S3_ACCESS_KEY_ID=
#DORMICE_S3_SECRET_ACCESS_KEY=
#DORMICE_S3_FORCE_PATH_STYLE=false
EOF
  chmod 600 "$ENV_FILE"
  note "wrote $ENV_FILE (mode 600) with a fresh API token"
fi
# Appended outside the create-once block so an upgrade re-run picks the
# knob up too. The knob is what turns on web domain binding in the console.
if [ -n "$INGRESS_FILE_READY" ] && ! grep -q '^DORMICE_INGRESS_FILE=' "$ENV_FILE"; then
  {
    echo '# The Caddy config file the daemon owns: enables binding domains (and'
    echo '# getting HTTPS) from the console domains page.'
    echo "DORMICE_INGRESS_FILE=$CADDYFILE"
  } >>"$ENV_FILE"
  note "added DORMICE_INGRESS_FILE=$CADDYFILE to $ENV_FILE"
fi

# ---- systemd service ---------------------------------------------------------
log 'systemd service'
cp "$INSTALL_DIR/deploy/dormice.service" /etc/systemd/system/dormice.service
systemctl daemon-reload
systemctl enable dormice >/dev/null 2>&1
# Restart, not start: a re-run just built fresh code, and the daemon is
# crash-only by design — restarting it is always safe.
systemctl restart dormice
note 'enabled and (re)started'

# ---- verification: the install has not succeeded until doctor says so --------
log 'verification'
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 \
  || die "the daemon did not answer /healthz on 127.0.0.1:$PORT — check: journalctl -u dormice -n 50"
note "daemon is answering on 127.0.0.1:$PORT"
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a
dor doctor

# Written only now: succeeded means what it says — the daemon restarted on
# the new code AND doctor proved the install whole, not merely "the script
# reached the end".
status_write succeeded

printf '\nDormice is installed.\n'
printf '  API token:   grep ^DORMICE_API_TOKEN %s\n' "$ENV_FILE"
printf '  daemon logs: journalctl -u dormice -f\n'
printf '  CLI:         export DORMICE_ENDPOINT=http://127.0.0.1:%s DORMICE_API_TOKEN=<token>; dor sandbox ls\n' "$PORT"
printf '  The daemon listens on 127.0.0.1 only, by design — exposing it is a reverse proxy'"'"'s job.\n'
if [ "$(systemctl is-active caddy 2>/dev/null)" = active ]; then
  printf '  console:     http://<this-host-ip>/console (Caddy on :80 — open your cloud firewall for 80/443,\n'
  printf '               then bind domains in the domains page for automatic HTTPS)\n'
fi
