FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

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
COPY apps/worker/ apps/worker/

WORKDIR /noddle/apps/worker

ARG NODDLE_COMMIT=""
ENV NODDLE_COMMIT=$NODDLE_COMMIT
ENV NODE_ENV=production

CMD ["node", "src/index.ts"]
