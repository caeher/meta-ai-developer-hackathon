FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

WORKDIR /workspace

COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/sandbox-controller/package.json apps/sandbox-controller/package.json
COPY apps/preview-gateway/package.json apps/preview-gateway/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/meta/package.json packages/meta/package.json
COPY packages/preview/package.json packages/preview/package.json
COPY packages/sandbox/package.json packages/sandbox/package.json
COPY packages/skills/package.json packages/skills/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY scripts/check-node-version.mjs scripts/check-node-version.mjs

RUN npm ci --no-audit --no-fund

COPY apps/preview-gateway/src apps/preview-gateway/src
COPY apps/preview-gateway/tsconfig.json apps/preview-gateway/tsconfig.json
COPY packages/contracts/src packages/contracts/src
COPY packages/db/src packages/db/src
COPY packages/preview/src packages/preview/src
COPY tsconfig.base.json tsconfig.base.json

CMD ["npm", "run", "start", "--workspace", "@meta-game/preview-gateway"]
