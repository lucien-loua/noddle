# Worker image.
#
# Bun installs, NODE runs. This is not a preference: `dockerode` through an SSH
# tunnel does not work on Bun, measured on both possible approaches (a custom
# HTTP agent, and a relayed Unix socket). Read the Hard rules in CLAUDE.md
# before "simplifying" this down to a single runtime.
#
# A single stage rather than a multi-stage build: Bun lays its packages out in
# node_modules/.bun behind symlinks, and copying those across stages is the
# kind of detail that breaks silently on a version bump.
FROM node:24-slim

# The worker talks to Docker ONLY over SSH, never through a local socket, so it
# needs neither the docker client nor nixpacks. Those live on the target
# machines, installed by the installer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /noddle

# Manifests first: as long as they do not change, the install layer is reused
# and the image rebuilds in seconds.
COPY package.json bun.lock ./
# EVERY workspace manifest, not only the ones this image needs:
# `--frozen-lockfile` compares the lockfile against the WHOLE workspace. Miss
# one and resolution differs, so the install fails on "lockfile had changes".
# verify-dockerfile-workspaces.ts holds this list to the package tree.
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/backup/package.json packages/backup/
COPY packages/backup-store/package.json packages/backup-store/
COPY packages/build-engine/package.json packages/build-engine/
COPY packages/compose-engine/package.json packages/compose-engine/
COPY packages/crypto/package.json packages/crypto/
COPY packages/database-spec/package.json packages/database-spec/
COPY packages/db/package.json packages/db/
COPY packages/deploy-contract/package.json packages/deploy-contract/
COPY packages/git-provider/package.json packages/git-provider/
COPY packages/notifier/package.json packages/notifier/
COPY packages/proxy-config/package.json packages/proxy-config/
COPY packages/registry/package.json packages/registry/
COPY packages/shared/package.json packages/shared/
COPY packages/ssh-credentials/package.json packages/ssh-credentials/
COPY packages/ssh-executor/package.json packages/ssh-executor/
COPY packages/swarm-ops/package.json packages/swarm-ops/
COPY packages/testing/package.json packages/testing/
COPY packages/tsconfig/package.json packages/tsconfig/

RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY packages/ packages/
COPY apps/worker/ apps/worker/

WORKDIR /noddle/apps/worker

# The commit THIS image is built from.
#
# It is the only thing proving the new code runs: `install.sh` checks out well
# before rebuilding, so HEAD on the host's disk changes minutes too early. The
# interface polls this variable until it changes.
ARG NODDLE_COMMIT=""
ENV NODDLE_COMMIT=$NODDLE_COMMIT

# Node reads TypeScript directly (type stripping). No build step, so nothing
# can diverge between what is tested and what runs.
CMD ["node", "src/index.ts"]
