# Image du dashboard.
#
# Bun de bout en bout — c'est le worker, et lui seul, qui doit tourner sur Node.
FROM oven/bun:1

WORKDIR /noddle

COPY package.json bun.lock ./
# TOUS les manifestes de l'espace de travail, pas seulement ceux dont cette
# image a besoin : `--frozen-lockfile` compare le lockfile à l'espace de
# travail ENTIER. S'il en manque un, la résolution diffère et l'installation
# échoue sur « lockfile had changes ».
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/backup-store/package.json packages/backup-store/
COPY packages/build-engine/package.json packages/build-engine/
COPY packages/db/package.json packages/db/
COPY packages/notifier/package.json packages/notifier/
COPY packages/proxy-config/package.json packages/proxy-config/
COPY packages/shared/package.json packages/shared/
COPY packages/ssh-executor/package.json packages/ssh-executor/
COPY packages/tsconfig/package.json packages/tsconfig/

RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY packages/backup-store/ packages/backup-store/
COPY packages/db/ packages/db/
COPY packages/notifier/ packages/notifier/
COPY packages/shared/ packages/shared/
COPY packages/tsconfig/ packages/tsconfig/
COPY apps/web/ apps/web/

WORKDIR /noddle/apps/web

# APP_KEY est lu au chargement du module de configuration, y compris pendant le
# rendu serveur de la construction. Une valeur jetable suffit ici : elle ne
# sert qu'à satisfaire la validation, et l'exécution reçoit la vraie.
RUN APP_KEY="$(head -c 32 /dev/urandom | base64)" \
    DATABASE_URL="postgres://build:build@localhost:5432/build" \
    REDIS_URL="redis://localhost:6379" \
    bun run build

EXPOSE 3000

# `vite build` produit un gestionnaire fetch et des fichiers statiques, mais
# aucun serveur. L'adaptateur officiel (nitro) est en beta ; server.ts les sert
# avec Bun.serve, en douze lignes.
CMD ["bun", "run", "server.ts"]
