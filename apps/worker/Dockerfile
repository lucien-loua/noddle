# Image du worker.
#
# Bun installe, NODE exécute. Ce n'est pas une préférence : `dockerode` à
# travers un tunnel SSH ne fonctionne pas sur Bun, mesuré sur les deux
# approches possibles (agent HTTP custom, et socket Unix relayé). Voir les
# Hard rules de CLAUDE.md avant de « simplifier » vers un seul runtime.
#
# Un seul étage plutôt qu'un multi-étage : Bun range ses paquets dans
# node_modules/.bun avec des liens symboliques, et les recopier d'un étage à
# l'autre est le genre de détail qui casse en silence à la montée de version.
FROM node:24-slim

# Le worker ne parle à Docker QUE par SSH, jamais par un socket local : il n'a
# donc besoin ni du client docker ni de nixpacks. Ils vivent sur les machines
# cibles, installées par l'installateur.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /noddle

# Les manifestes d'abord : tant qu'ils ne changent pas, la couche
# d'installation est réutilisée et l'image se reconstruit en secondes.
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
COPY packages/ packages/
COPY apps/worker/ apps/worker/

WORKDIR /noddle/apps/worker

# Node lit le TypeScript directement (type stripping). Pas d'étape de build,
# donc rien qui puisse diverger entre ce qui est testé et ce qui tourne.
CMD ["node", "src/index.ts"]
