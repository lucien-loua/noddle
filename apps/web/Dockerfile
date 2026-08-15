# Dashboard image.
#
# Bun end to end — the worker, and it alone, has to run on Node.
FROM oven/bun:1

WORKDIR /noddle

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
# The whole tree, like the worker image does, and not a hand-picked list.
# `vite build` really imports these packages — `@noddle/ssh-executor/keys` to
# build a key pair, for one — and a manifest alone satisfies
# `--frozen-lockfile`, so a missing source shows up neither at typecheck, nor
# at lint, nor in a local `vite build` that resolves through the monorepo. It
# only appears while building THIS image. That list was already patched for
# backup-store, notifier and ssh-executor in turn; copying everything ends the
# series.
COPY packages/ packages/
COPY apps/web/ apps/web/

# The commit THIS image is built from.
#
# It is the only thing proving the new code runs: `install.sh` checks out well
# before rebuilding, so HEAD on the host's disk changes minutes too early. The
# interface polls this variable until it changes.
ARG NODDLE_COMMIT=""
ENV NODDLE_COMMIT=$NODDLE_COMMIT

WORKDIR /noddle/apps/web

# APP_KEY is read when the config module loads, including during the build's
# server rendering. A throwaway value is enough here: it only satisfies
# validation, and the runtime receives the real one.
RUN APP_KEY="$(head -c 32 /dev/urandom | base64)" \
    DATABASE_URL="postgres://build:build@localhost:5432/build" \
    REDIS_URL="redis://localhost:6379" \
    bun run build

EXPOSE 3000

# `vite build` produces a fetch handler and static files, but no server. The
# official adapter (nitro) is in beta; server.ts serves them with Bun.serve, in
# twelve lines.
CMD ["bun", "run", "server.ts"]
