# Dormice sandbox base image: Ubuntu 24.04 + Python 3.12 + Node.js 24 LTS.
#
# Three rules this file lives by:
#   1. Layers are ordered by change frequency: system packages at the bottom,
#      the user account at the top, so routine tweaks rebuild little.
#   2. Everything installs into image paths (/opt, /usr/local), never into
#      /home/user — the per-sandbox disk is mounted over that directory at
#      runtime and would shadow anything baked underneath.
#   3. The sandbox runs as a non-root user (uid 1000, named "user").
#
# Build: docker build -t dormice-base:<date> images/
# Every *_MIRROR / *_DIST / *_INDEX / *_REGISTRY arg is optional and defaults
# to the official source; override them when building behind a slow network.

FROM ubuntu:24.04

# ---- Layer 1: system packages + Python (changes least) ----
# Removing EXTERNALLY-MANAGED: Ubuntu 24.04 blocks bare `pip install`
# (PEP 668); inside a disposable sandbox it must just work.
ARG UBUNTU_MIRROR=
RUN if [ -n "$UBUNTU_MIRROR" ]; then \
      sed -i "s|http://archive.ubuntu.com/ubuntu/|$UBUNTU_MIRROR|g; s|http://security.ubuntu.com/ubuntu/|$UBUNTU_MIRROR|g" \
        /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv python3-dev \
      build-essential ca-certificates curl wget git unzip xz-utils \
      vim-tiny less jq ripgrep inotify-tools \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/lib/python3.12/EXTERNALLY-MANAGED \
 && ln -sf /usr/bin/python3 /usr/local/bin/python

# ---- Layer 2: Node.js LTS into /opt, sha256-pinned ----
# The checksum comes from the official SHASUMS256.txt, so a poisoned mirror
# cannot slip a different tarball through no matter what NODE_DIST points at.
ARG NODE_VERSION=v24.18.0
ARG NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
ARG NODE_DIST=https://nodejs.org/dist
RUN curl -fsSL -o /tmp/node.tar.xz "$NODE_DIST/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" \
 && echo "$NODE_SHA256  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /opt \
 && rm /tmp/node.tar.xz \
 && for b in node npm npx corepack; do \
      ln -s "/opt/node-$NODE_VERSION-linux-x64/bin/$b" "/usr/local/bin/$b"; \
    done

# ---- Layer 3: package-manager sources (tweaked more often) ----
# These affect what `pip install` / `npm install` reach at runtime, inside
# the sandbox — set them to regional mirrors when the host network needs it.
ARG PIP_INDEX=
ARG NPM_REGISTRY=
RUN if [ -n "$PIP_INDEX" ]; then \
      printf '[global]\nindex-url = %s\n' "$PIP_INDEX" > /etc/pip.conf; \
    fi \
 && if [ -n "$NPM_REGISTRY" ]; then \
      mkdir -p "/opt/node-$NODE_VERSION-linux-x64/etc" \
      && printf 'registry=%s\n' "$NPM_REGISTRY" > "/opt/node-$NODE_VERSION-linux-x64/etc/npmrc"; \
    fi

# ---- Layer 4: non-root user (top layer) ----
# ubuntu:24.04 ships an "ubuntu" user at uid 1000; replace it with "user" so
# the uid the executor chowns sandbox disks to always maps to the same name.
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /bin/bash user
ENV LANG=C.UTF-8
USER user
WORKDIR /home/user
CMD ["/bin/bash"]
