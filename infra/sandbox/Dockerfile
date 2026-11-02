ARG NODE_BASE_IMAGE=docker.io/library/node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
FROM ${NODE_BASE_IMAGE} AS build-fs-helper

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY infra/sandbox/workspace-fs.c /tmp/workspace-fs.c
RUN cc -static -O2 -Wall -Wextra -Werror -o /tmp/workspace-fs /tmp/workspace-fs.c \
    && chmod 0755 /tmp/workspace-fs

FROM ${NODE_BASE_IMAGE}

ENV HOME=/tmp \
    TMPDIR=/tmp \
    npm_config_cache=/tmp/npm-cache \
    PLAYWRIGHT_BROWSERS_PATH=/opt/meta-game/browsers \
    NODE_ENV=development

RUN groupadd --system --gid 10000 sandbox \
    && useradd --system --uid 10000 --gid sandbox --no-create-home --home-dir /nonexistent sandbox \
    && mkdir -p /workspace \
    && chown 0:0 /workspace \
    && chmod 1777 /workspace

RUN mkdir -p /opt/meta-game \
    && npm install --prefix /opt/meta-game --no-save --ignore-scripts playwright@1.64.1 \
    && /opt/meta-game/node_modules/.bin/playwright install --with-deps --only-shell chromium

COPY --from=build-fs-helper /tmp/workspace-fs /usr/local/bin/workspace-fs
COPY infra/sandbox/egress-proxy.mjs /opt/meta-game/egress-proxy.mjs
COPY infra/sandbox/server-manager.mjs /opt/meta-game/server-manager.mjs
COPY infra/sandbox/verify-game.mjs /opt/meta-game/verify-game.mjs
RUN chmod 0755 /usr/local/bin/workspace-fs \
    && chmod 0444 /opt/meta-game/egress-proxy.mjs /opt/meta-game/server-manager.mjs /opt/meta-game/verify-game.mjs \
    && chmod -R a+rX /opt/meta-game

USER 10000:10000
WORKDIR /workspace
CMD ["/bin/sleep", "infinity"]
