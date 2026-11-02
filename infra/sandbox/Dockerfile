ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE}

ENV HOME=/tmp \
    TMPDIR=/tmp \
    npm_config_cache=/tmp/npm-cache \
    NODE_ENV=development

RUN addgroup -S -g 10000 sandbox \
    && adduser -S -D -H -u 10000 -G sandbox sandbox \
    && mkdir -p /workspace \
    && chown 10000:10000 /workspace

USER 10000:10000
WORKDIR /workspace
CMD ["/bin/sleep", "infinity"]
