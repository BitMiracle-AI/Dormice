# Builds the static website and serves it with Caddy. Written for Dokploy
# (build type: Dockerfile, context: repo root, dockerfile: website/Dockerfile);
# TLS is terminated by the platform's reverse proxy in front, so the Caddy in
# here only serves files and answers redirects — see website/Caddyfile.
#
# The build context must be the repo root: the pnpm lockfile and workspace
# manifest live there, even though the website has no workspace dependencies.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY website/package.json website/
RUN pnpm install --frozen-lockfile --filter @dormice/website
COPY website/ website/
RUN pnpm --filter @dormice/website build

FROM caddy:2-alpine
COPY website/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/website/out /srv
