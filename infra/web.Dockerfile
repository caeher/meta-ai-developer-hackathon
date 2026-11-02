FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

WORKDIR /workspace

COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY scripts/check-node-version.mjs scripts/check-node-version.mjs

RUN npm ci --no-audit --no-fund

COPY apps/web/app apps/web/app
COPY apps/web/styles apps/web/styles
COPY apps/web/next.config.ts apps/web/next.config.ts
COPY apps/web/tsconfig.json apps/web/tsconfig.json
COPY packages/config/src packages/config/src
COPY packages/config/tsconfig.json packages/config/tsconfig.json
COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY tsconfig.base.json tsconfig.base.json

ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000

CMD ["npm", "run", "dev", "--workspace", "@meta-game/web", "--", "--hostname", "0.0.0.0"]
