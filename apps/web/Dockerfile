FROM oven/bun:1

WORKDIR /noddle

COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/backup/package.json packages/backup/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/deploy-contract/package.json packages/deploy-contract/
COPY packages/deploy-engine/package.json packages/deploy-engine/
COPY packages/git-provider/package.json packages/git-provider/
COPY packages/git-provider-credentials/package.json packages/git-provider-credentials/
COPY packages/shared/package.json packages/shared/
COPY packages/ssh-credentials/package.json packages/ssh-credentials/
COPY packages/ssh-executor/package.json packages/ssh-executor/
COPY packages/testing/package.json packages/testing/
COPY packages/tsconfig/package.json packages/tsconfig/

RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/

ARG NODDLE_COMMIT=""
ARG NODDLE_VERSION=""
ENV NODDLE_COMMIT=$NODDLE_COMMIT
ENV NODDLE_VERSION=$NODDLE_VERSION

WORKDIR /noddle/apps/web

RUN APP_KEY="$(head -c 32 /dev/urandom | base64)" \
    DATABASE_URL="postgres://build:build@localhost:5432/build" \
    REDIS_URL="redis://localhost:6379" \
    bun run build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "run", "server.ts"]
