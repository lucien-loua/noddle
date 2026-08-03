# CLAUDE.md — Noddle

Read this at the start of every session. It is the source of truth for what
Noddle is and what has already been decided.

---

## What Noddle is

A self-hosted deployment platform. You point it at a git repo, it builds and
runs the app on a VPS you own, with HTTPS and a domain, from a dashboard.

Installed on any Linux VPS with one command. Manages one or many target servers.

**The differentiator is restraint, not features.** Comparable tools lose to
feature creep and cluttered dashboards. Every screen must answer "is it healthy"
and "how do I ship" without drilling into a submenu. When in doubt, cut.

---

## Settled decisions — do not relitigate

These are decided. Do not re-open them, do not silently work around them, do not
propose alternatives in passing.

If you have strong evidence one is wrong, **say so once, explicitly, and stop for
an answer.** Do not proceed on your own judgment.

| Decision | Choice | Why |
|---|---|---|
| Orchestration | **Docker Swarm mode**, single node to start | `docker service update` is a transactional deploy primitive — rolling update, health gate and rollback are already correct, including edge cases |
| Build location | **On the target server** | "one command on any VPS" is a core requirement; building elsewhere needs an always-on machine or a registry hop |
| Build isolation | **Every build resource-capped**, via a capped buildx builder | a Next.js build on a 2 GB VPS will OOM and take down running production apps |
| Server access | **Agentless, SSH only** | adding a server = paste a host and a key, nothing else |
| Own host | **The installer registers its own host as target server #1** | single-box is the common case, not the exception. One Traefik per host — the installer's *is* the app Traefik. The local target goes through the SSH executor like any other, so there is no `localhost` special case and the loopback path is exercised by every user |
| Deploy targets | **Docker only** | no bare-metal or systemd paths |
| Reverse proxy | **Traefik**, Swarm provider | dynamic label-based routing, native Let's Encrypt |
| RPC layer | **TanStack Start `createServerFn`**, no tRPC | Start already gives end-to-end type safety; two RPC layers is waste. tRPC only if a public API or CLI ever needs a versioned contract outside the app |
| Logs worker → web | **Redis pub/sub pour le direct, liste plafonnée pour le rattrapage, fichier pour l'archive** | Le worker et le web sont deux processus sur deux runtimes ; le callback `onLog` ne franchit pas cette frontière. Suivre le fichier depuis le web ferait reposer le direct sur inotify à travers un bind mount, entre Node qui écrit et Bun qui lit — la classe d'interaction tierce qui a causé toutes les ruptures. Redis est déjà là pour BullMQ |
| Design system | **shadcn/ui, préréglage `b1VlJj2R`** (luma / neutral / phosphor / inter) sur Tailwind v4 | Base UI, pas Radix. Un seul jeton ajouté au préréglage : `--success`, parce que le neutre n'a que `destructive` et qu'un écran de déploiement doit dire « ça tourne » sans être lu |
| Late crashes | **Noddle watches after the deploy and rolls back itself** | Swarm's guarantee expires with `--update-monitor`. Past that window there is nothing left to roll back to. Noddle keeps full deployment history, so it can return to *any* previous image — Swarm can only return to one |
| Multi-serveur | **Un seul manager Swarm, tout serveur ajouté rejoint en WORKER** | `docker service create/update` exige un manager — il détient seul l'état répliqué du cluster ; un worker le refuse. Rester à un manager évite aussi la question de la taille du quorum Raft, qu'on ne veut pas rouvrir en Phase 2. `role` porte ce fait, colonne séparée d'`isSelf` qui reste display-only par décision déjà actée |

**License: AGPL-3.0** (`LICENSE` at the repo root), open-core. The core is free;
anyone who runs it as a hosted service must publish their modifications, which is
what keeps a managed offering viable. RBAC, SSO, audit logs and white-labeling are
the intended paid tier — build them so they can be separated, but do not
prematurely split the repo.

Practical consequence: **every new file is AGPL from now on.** Do not paste in
code under an incompatible license, and do not add a dependency whose license
conflicts (permissive is fine; other copyleft needs checking). Relicensing after
contributors arrive is painful, which is why this was settled before publishing.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | TanStack Start (Router, Query, Table, Form) |
| Validation | Zod, schemas shared client/server |
| ORM | Drizzle + Postgres |
| Auth | better-auth |
| Job queue | BullMQ + Redis |
| Remote exec | `ssh2` over SSH, `dockerode` for the Docker Engine API tunneled through SSH |
| Builds | Nixpacks (shelled out to), or Dockerfile if present |
| Realtime | SSE via a Start server function stream |
| Package manager | Bun (workspaces via `package.json`) — partout |
| Runtime | Bun, **sauf `apps/worker` qui tourne sur Node** (voir Hard rules : `dockerode` par tunnel SSH ne fonctionne pas sur Bun) |

---

## Repo layout

```
/apps
  /web              TanStack Start app (UI + server functions)
  /worker           BullMQ worker — build and deploy jobs
/packages
  /db               Drizzle schema + migrations
  /ssh-executor     SSH pool, remote docker command wrappers
  /build-engine     Nixpacks invocation, image build
  /proxy-config     Traefik label generation
  /shared           Zod schemas, shared types
/installer
  install.sh
  docker-compose.yml
```

`web` and `worker` are separate processes from day one. Deploys take minutes —
never run a build inside a server function.

---

## Local development topology

Development runs against **local Multipass VMs**, not a rented VPS. A VM is the
closest free equivalent of a real server: real systemd, real network stack, real
SSH, real Docker install path.

Do **not** substitute Docker-in-Docker for a VM. Swarm overlay networks create
VXLAN interfaces even on a single node; DinD mostly works and fails in ways that
do not exist in production.

- Target VMs are provisioned at **2 GB RAM on purpose** — the size of a cheap VPS, and the only way to actually reproduce the OOM scenario the build-capping decision exists to prevent. Do not raise it to make a build pass; that is the bug.
- Access is over **real SSH with a key**, never `multipass exec`. SSH is the production access path, so it is the one that must be exercised.
- Hostnames use `sslip.io` (`app.10-0-0-5.sslip.io` resolves to `10.0.0.5`), so Host-based routing is tested without editing `/etc/hosts`.
- Multi-server work in Phase 2 means launching a second and third VM, not mocking one.
- **OrbStack was evaluated and dropped.** It does work — measured 7/7: Docker, Swarm, a real VXLAN overlay and Traefik routing, on a 2 GB-capped machine over real SSH. It was dropped anyway, to keep one target and one code path. Do not propose it again.

**TLS cannot be fully tested locally.** ACME requires a publicly reachable
domain. In dev, Traefik serves plain HTTP. To exercise the ACME code path
without real certificates, point
`--certificatesresolvers.le.acme.caserver` at **Pebble** (Let's Encrypt's test
server). Real certificate issuance needs exactly one run against a real VPS with
real DNS before shipping — budget for it, do not skip it.

---

## Current phase

**Phase 0 is DONE.** All four criteria below passed on a real 2 GB Multipass VM
(Docker 29.7.0, Traefik v3.7.9, nixpacks 1.41.0, arm64) on 2026-07-31. A broken
image rolled back with the previous version serving uninterrupted; a build that
climbed to 896 MB was killed by the cap while the running service answered
identically throughout.

**CI is live** — `.github/workflows/spike.yml` runs all four checks on every push
touching `scripts/`, on PRs, and nightly at 04:00 UTC. Green on the first run
(7m53s). It runs the chain on the runner itself over SSH to localhost, since
GitHub does not support nested virtualisation and the runner is already a VM with
its own kernel. That is the settled topology, so CI exercises the production path.

Do not re-run Phase 0 by hand, and **do not let a red spike sit**. Six of the
seven Phase 0 failures were third-party version or flag interactions, none in our
own logic — that is this project's real risk profile, and the spike is the only
thing that detects it. Dokploy is currently shipping the Traefik/Docker break to
users for exactly this reason. When it goes red, read the job summary first: it
prints the Docker, Traefik and nixpacks versions so you can see what moved.

CI does **not** reproduce the 2 GB constraint — a runner has 16 GB, so "the
service survives the build" is trivially true there. It validates the cap
*mechanism* and dependency drift. The local Multipass run stays the pre-ship gate.

### Phase 1 — état au 2026-08-02

Chaque paquet a un `src/verify.ts` lancé contre de VRAIES ressources. Les
relancer après toute montée de version : c'est le seul filet contre la dérive
des dépendances, qui est le risque principal de ce projet.

| Paquet | Vérifié contre | |
|---|---|---|
| `packages/ssh-executor` | VM Multipass | 9/9 |
| `packages/db` | PostgreSQL 17 | migration appliquée + client |
| `packages/shared` | — (pur) | 17/17, deux runtimes |
| `packages/build-engine` | VM Multipass | 14/14, cgroup lu sur le conteneur |
| `packages/proxy-config` | — (pur) | intégré |
| `apps/worker` — Swarm | VM Multipass | 8/8, rollback détecté |
| `apps/worker` — bout en bout | Postgres + VM | 12/12, base → URL vivante |
| `apps/worker` — surveillance | Postgres + VM | 8/8, boucle de crash rattrapée |
| `apps/worker` — file | Postgres + Redis | 5/5, processus + BullMQ |
| `apps/web` | Postgres + Redis, serveur CONSTRUIT | 17/17, auth → dashboard → file → SSE |
| `apps/web` — en direct | Postgres + Redis + VM, **3 processus** | 14/14, build réel vu depuis le dashboard |

**Fait :** exécuteur SSH, schéma + migration, chiffrement AES-256-GCM lié par
AAD, validation Zod, moteur de build capé, labels Traefik, job de déploiement,
rollback depuis l'historique, surveillance post-déploiement, câblage BullMQ,
**et `apps/web`** : better-auth (compte admin unique), dashboard unique, flux
SSE des logs, bouton déployer, rollback depuis l'historique, table de variables
d'environnement avec diff avant enregistrement.

**L'installateur est écrit et prouvé sur une VM neuve.** `curl | bash` amène
Docker, Swarm, le réseau overlay, les secrets, une clé SSH, la pile Compose
(Traefik/Postgres/Redis/web/worker), les migrations, puis l'adoption de
l'hôte comme serveur n°1 — en une seule passe piped, sans intervention. Testé
sur une VM Multipass à 2 Go, système d'exploitation vierge, jusqu'au compte
administrateur créé au navigateur et un vrai déploiement (`installeur
bonjour`) servi par le Traefik que le script vient d'installer.

Un piège trouvé et corrigé, de la même famille que `cmd | grep -q` déjà noté
plus bas mais sur l'ENTRÉE cette fois : sans `</dev/null` sur chaque
`docker compose run`, le sous-processus hérite du flux d'entrée standard du
script — qui est justement le canal par lequel `curl | bash` alimente
`install.sh`. Il en consomme le reste, bash atteint une fin de fichier
silencieuse, et le script sort en code 0 sans avoir exécuté les commandes
restantes. Mesuré deux fois : les migrations tournaient, l'adoption jamais,
et `$?` valait 0 dans les deux sens de vérification — donc invisible depuis
l'appelant. C'est exactement pour ça que la méthode d'installation
documentée doit être testée telle quelle, pas approximée par un `bash
install.sh` local.

**La boucle complète est prouvée contre du réel.** `apps/web/src/verify-live.ts`
lance les TROIS processus (Postgres, worker Node, web Bun) et déclenche un vrai
build nixpacks sur la VM : la sortie de nixpacks et de buildx traverse Redis et
ressort dans le flux SSE du dashboard, le service passe en service, et le
rollback rejoue l'image sans reconstruire. Le bouton Déployer a aussi été
cliqué dans un vrai navigateur.

Deux défauts que SEUL ce passage a montrés, tous deux corrigés :

- buildx émet des séquences ANSI **même sous `--progress=plain`** : le dashboard
  affichait « `[33m1 warning found` ». Le nettoyage est à l'affichage
  (`log-stream.tsx`), pas dans le puits de logs — le fichier d'archive doit
  rester l'octet exact produit par la VM.
- `redeployImage` n'écrivait pas de `commit_sha` : après un rollback,
  l'historique affichait « — » en commit. Le dashboard savait quelle IMAGE
  tournait mais plus quel CODE, alors que c'est exactement la question qu'on
  pose à ce moment-là. Le SHA est repris du déploiement qui a construit l'image.

**La Phase 1 est close.** Les deux éléments qui restaient — le web et
l'installateur — sont faits et vérifiés contre du réel, chacun sur une machine
neuve. Phase 2 : multi-serveur, déploiements Docker Compose, webhooks,
services de base de données en un clic.

### Phase 2 — état au 2026-08-02

**Multi-serveur fait et vérifié contre DEUX vraies VM Multipass.**

Un seul manager, jamais plus : c'est la machine `role='manager'` en base
(distincte d'`isSelf`, qui reste display-only par décision déjà actée — voir
plus haut). Tout serveur ajouté rejoint le MÊME cluster Swarm en tant que
worker. `docker service create/update` refuse sur un worker — lui seul détient
l'état répliqué du cluster — donc `deploy.ts` ouvre deux connexions dès que le
service n'est pas hébergé sur le manager : le BUILD sur le serveur du service,
les commandes SWARM sur le manager, avec une contrainte de placement
(`node.id==…`) qui épingle la task au nœud qui a réellement construit l'image
— sans registre, elle n'existe nulle part ailleurs, et le planificateur Swarm
la placerait aveuglément sans cette contrainte. `sweep.ts` (la surveillance
post-déploiement) suit la même règle : `listTasks` doit lire le manager, un
worker y répondrait par une erreur.

L'ajout d'un serveur (`addServer` + `provisionServer`) installe Docker si
absent, rejoint le cluster en WORKER — jamais manager, pour ne jamais rouvrir
la question de la taille du quorum Raft — installe nixpacks, puis relève les
mêmes faits que la machine n°1. Rejouable : une seconde exécution sur un
serveur déjà connecté est un no-op silencieux.

| Vérifié | Contre | |
|---|---|---|
| Provisionnement + placement + rollback + HTTP inter-nœuds | 2 VM Multipass réelles (`verify-multi.ts`) | 11/11 |
| Formulaire « Ajouter un serveur », chemin d'échec | navigateur réel + worker réel | statut et `lastError` corrects, sans recharger la page |

**Non vérifié par navigateur : le chemin de succès de l' UI d'ajout.** Il
aurait fallu coller une vraie clé privée dans un champ de formulaire piloté par
Playwright ; l'utilisateur a refusé l'action équivalente (`cat` de la clé) et
ce refus a été respecté sans contournement. Le mécanisme est prouvé côté
worker (`verify-multi.ts`, en direct) et côté UI pour l'échec (mêmes
composants, seul le badge de statut diffère) — mais personne n'a regardé le
badge passer à « Connecté » dans un vrai navigateur.

**« Connecter un dépôt » fait et vérifié en direct dans un vrai navigateur.**
Le manque hérité de la Phase 1 — aucune UI de création de service, toutes les
vérifications précédentes créaient leurs services par SQL directement — est
comblé : `connectRepo` (retrouve-ou-crée projet et environnement par nom,
`sourceType`/`buildMethod` non exposés au formulaire puisque git+nixpacks est
le seul chemin que le worker sache exécuter) et le dialogue
`ConnectRepoDialog`. Testé de bout en bout contre une vraie infrastructure :
dépôt public connecté, déployé, échec de bascule attendu (l'appli écoute sur
`$PORT`, par défaut 5000, le service était configuré sur 3000), corrigé via la
table de variables d'environnement déjà existante, redéployé, convergé, et la
surveillance post-déploiement s'est levée d'elle-même après ses 5 minutes,
sans rollback.

**Déploiements Docker Compose faits et vérifiés contre une vraie VM, 10/10
(`verify-stack.ts`).** Nouvelle table `stacks` (+ `stack_deployments`,
`stack_deployment_logs`) : plusieurs conteneurs sous un même nom, distincte de
`services` — un seul serveur (même raison qu'un service : une image construite
localement n'existe que sur ce nœud), et AU PLUS un sous-service public
(`publicService` + `domain` + `port`), pas N domaines par pile.

Le mécanisme, dans `apps/worker/src/compose.ts` : lire le fichier compose,
construire chaque service avec un `build:` sur le MÊME builder capé que le
chemin nixpacks (Dockerfile fourni par l'utilisateur, pas de génération),
réécrire `build:` en `image:`, injecter placement/health-gate/labels, puis
**`docker stack deploy`** — littéralement la commande, jamais une boucle de
`docker service create` maison, pour laisser Swarm traduire une syntaxe
compose arbitraire (réseaux, volumes) plutôt que la réimplémenter. Elle rend
la main avant convergence tout comme `docker service update` — même piège,
multiplié par service — donc chaque service résultant est relu un par un avec
`waitForRunningTask`/`readUpdateState`, EXPORTÉS de `swarm.ts` sans un
changement de logique. Le rollback stocke le texte compose PRÉ-réécriture et
les tags construits dans `stack_deployments` : rejouer une version passée ne
touche ni au dépôt ni à un nouveau build, même principe que `redeployImage`.
La surveillance post-déploiement (`sweep.ts`) couvre les piles : une pile
boucle si N'IMPORTE LEQUEL de ses services boucle, pas seulement le public.

**Un bug préexistant trouvé en vérifiant que `sweep.ts` ne régressait pas** (
la Phase 1, pas ce chantier) : deux déploiements successifs du MÊME service,
tous deux encore sous surveillance, se confondaient — `inspectServiceHealth`
vérifie un nom de service Swarm, pas quel déploiement a produit quelle task,
donc le crash du PLUS RÉCENT se lisait comme une boucle de l'ANCIEN, qui se
retrouvait sans version antérieure vers laquelle revenir. `verify-watch.ts`
échouait par exactement ce chemin. Corrigé par `clearSupersededWatch` (et son
équivalent pour les piles) : dès qu'un déploiement devient le courant, la
fenêtre de surveillance de tout autre déploiement du même service/pile est
purgée. Reproduit sur le code d'AVANT ce chantier (stash + DB propre) avant
correction, pour confirmer que ce n'était pas une régression — voir `git
stash` dans l'historique de session si le doute revient.

**Non vérifié par navigateur : le chemin de succès du formulaire « Connecter
une pile Compose ».** Même obstacle que le formulaire d'ajout de serveur en
Phase 2 : la validation Zod refuse `file://` (correct, même règle que
`connectRepoSchema`), donc un test de bout en bout demande une vraie URL
`https://` ou `git@`. Une tentative de servir le dépôt de test via git+ssh
directement sur la VM cible (nouvel utilisateur système `git`) a été
abandonnée sur refus de l'utilisateur — changement jugé trop intrusif pour une
VM de test partagée — et annulée proprement (utilisateur supprimé). Le
mécanisme est prouvé côté worker (`verify-stack.ts`, 10/10, en direct) et la
validation du formulaire est confirmée correcte ; personne n'a regardé le
bouton Déployer d'une pile fonctionner de bout en bout dans un vrai
navigateur.

**Reste pour la Phase 2 :** webhooks, bases de données en un clic.

**Pièges déjà payés, à ne pas repayer :**

- **Le healthcheck injecté suppose `curl` présent, vrai pour les images
  nixpacks mais PAS pour un Dockerfile Compose arbitraire.** Une image
  `python:3-alpine` toute nue n'a pas `curl` : le healthcheck échoue en boucle,
  Swarm tue le conteneur (exit 137), et ça se présente comme un déploiement
  qui « n'a pas convergé en 180s » — aucune indication que la cause est un
  binaire manquant. Mesuré sur `verify-stack.ts` avant d'ajouter `RUN apk add
  --no-cache curl` au Dockerfile de test. Conséquence produit : un utilisateur
  Compose dont l'image de base n'a pas `curl` verra son service public échouer
  à converger pour cette seule raison — pas documenté ailleurs qu'ici pour
  l'instant.

- Une file BullMQ ne peut pas contenir `:` — la v6 s'en sert comme séparateur de
  clés Redis, et le processus ne démarre pas du tout.
- À la CRÉATION d'un service Swarm il n'y a pas d'`UpdateStatus` : sans attendre
  qu'une task atteigne `running`, un premier déploiement cassé est enregistré
  comme réussi.
- Le provider Swarm de Traefik ne scrute que toutes les 15 s : une task
  convergée n'est PAS immédiatement joignable.
- `fetch` ignore silencieusement un en-tête `Host`, il est interdit par la spec.
  Utiliser le domaine, ou `curl -H`.
- Un `biome-ignore` doit être la DERNIÈRE ligne de commentaire avant le code ;
  toute ligne d'explication ajoutée après le détache en silence.
- Les versions des dépendances tierces vivent dans `workspaces.catalog` à la
  racine, et chaque paquet écrit `catalog:`. Deux versions de `drizzle-orm` ont
  cohabité en silence et produit des types incompatibles.
- **Aucun import relatif sans extension dans le code que Node charge.** Node ne
  devine ni l'extension ni un `index.ts` de dossier : `./schema/auth` échoue
  avec `ERR_MODULE_NOT_FOUND`, mesuré. La réponse retenue est le champ
  `imports` de package.json (`"#*": "./src/*.ts"`), qui donne des
  specificateurs SANS extension (`#schema/auth`) et que Node résout. Vérifié
  sur les deux runtimes. `apps/web` n'en a pas besoin — Vite résout tout — et
  utilise l'alias `@/`.
- `vite/client` ne se résout PAS dans le champ `types` de tsconfig sous
  TypeScript 7 : l'échec est silencieux et se manifeste par un
  `*.css?url` introuvable. Passer par une référence triple-slash dans
  `src/vite-env.d.ts`. Pour la même raison, importer la feuille de style en
  RELATIF : un chemin passé par `paths` est résolu avant que le joker
  `declare module '*?url'` s'applique.
- `vite build` de TanStack Start produit un gestionnaire `fetch` et les
  fichiers statiques, mais **aucun serveur**. L'adaptateur officiel (nitro) est
  en beta ; `apps/web/server.ts` sert le tout avec `Bun.serve`, en douze
  lignes. Son `idleTimeout: 0` est obligatoire : par défaut Bun coupe à 10 s et
  le flux SSE des logs se reconnecte en boucle pendant tout un build.
- Les composants de `apps/web/src/components/ui/` viennent du registre shadcn
  et sont exclus de Biome : `shadcn add` les réécrit d'un bloc.
- **L'utilisateur SSH d'un serveur qu'on vient de provisionner n'a pas encore
  accès au socket Docker.** `usermod -aG docker` ne prend effet qu'à une
  NOUVELLE session — la connexion SSH en cours ne le voit jamais, qu'on vienne
  d'installer Docker ou non. Sans reconnexion explicite après l'ajout au
  groupe, le premier `dockerClient()` échoue avec « Channel open failure »,
  puisque ce chemin ouvre le socket EN DIRECT, sans `sudo` possible dessus
  (déjà documenté dans `@noddle/ssh-executor`, mais oublié à l'écriture de
  `provision.ts` — mesuré contre une VM réellement nue avant d'être corrigé).
- **Traefik écoute en `mode=host`, sur le manager uniquement**
  (`--constraint 'node.role==manager'`, `scripts/spike-local.sh`). Sur
  plusieurs nœuds, le domaine sslip.io d'un service encode l'IP du nœud qui
  l'exécute — souvent un WORKER, où rien n'écoute sur le port 80. Un test HTTP
  doit dialoguer avec le manager, avec l'en-tête `Host` de la règle Traefik.
  `fetch` ne peut pas le fournir (interdit par la spec, déjà noté plus haut) :
  `curl -H` en sous-processus, jamais `fetch`, dès qu'on vérifie du multi-nœud.

---

### Phase 0 — validate the deploy chain end to end (reference)

`scripts/spike-local.sh` must pass on a local VM before any application code gets
written. Nothing else matters until it does.

**A working URL is not the exit criterion.** Both of Noddle's differentiators are
failure-path behaviours, so the happy path proves almost nothing. All four of
these must pass:

| Run | Proves |
|---|---|
| `./spike-local.sh` | the chain works: SSH → Swarm → clone → Nixpacks → service create → Traefik → HTTP |
| `./spike-local.sh` (again) | the `docker service update` path — where zero-downtime is observable |
| `./spike-local.sh break` | a broken image does not take down the running version; Swarm health-gates and rolls back |
| `./spike-local.sh cap` | a memory-hungry build gets killed by the cap and the running service is untouched |

`break crash` covers the harder case: the container passes its healthcheck, then
dies. That is the one hand-rolled swap logic always gets wrong.

Then, in order:

1. **Phase 1** — Drizzle schema + BullMQ, spike logic ported into a worker job. Auth, installer adopts its own host as server #1, connect a repo, deploy, live log stream, start/stop/restart, rollback, and the **post-deploy watch** (see Hard rules: Swarm's guarantee expires with the monitor window, so the worker keeps observing and rolls back from Noddle's own history). Rollback is not a Phase 3 nicety here — it is the mechanism the watch depends on.
2. **Phase 2** — multi-server, Docker Compose deploys via `docker stack deploy`, env var UI, webhook deploys, one-click database services.
3. **Phase 3** — backups to S3-compatible storage, notifications, resource graphs, teams/RBAC.
4. **Phase 4** — registry-based builds, preview environments per PR, audit log, CLI.

**Do not build Phase 2 features while Phase 1 is unreliable.** The deploy loop's
correctness is what the entire product's trust rests on.

---

## Hard rules

**Bun is the package manager everywhere. `apps/worker` runs on NODE — settled by
measurement, not preference.** `packages/ssh-executor/src/verify.ts` runs the real
paths against a real VM; run it on both runtimes to re-check after any upgrade:

| | `ssh2` | `dockerode` over the SSH tunnel | |
|---|---|---|---|
| Node 24 | ✓ | ✓ Docker 29.7.1, `UpdateStatus.State` readable | **9/9** |
| Bun 1.3.13 | ✓ | ✗ `ECONNREFUSED` | 6/7 |

`ssh2` itself is fine on Bun — connection, exec, exit codes, chunked streaming.
What breaks is `dockerode` over the tunnel. **Two independent approaches were
tried and both fail on Bun:**

| approach | Node | Bun |
|---|---|---|
| custom `createConnection` on `http.Agent` | ✓ | ✗ `ECONNREFUSED` — Bun ignores it and opens a real TCP connection to the placeholder host |
| local Unix socket proxied to the remote socket over an SSH channel (no agent at all) | ✓ | ✗ hangs forever on the first request |

The second was the obvious escape hatch — no custom agent, so nothing for a
runtime to ignore — and it still hangs. Only the `http.Agent` path is kept in the
code; the socket-proxy variant was deleted rather than left as dead code.

So: Bun for install/workspaces/scripts, Node for the worker process. Do not
"simplify" this back to one runtime without re-running the verifier.

Scope of the constraint: **only `dockerode` is affected.** `postgres.js` and
Drizzle were smoke-tested on both runtimes against a real Postgres 17 — inserts,
relational queries and enums all work identically. So `packages/db` is runtime
agnostic; do not assume the Node requirement spreads.

Two constraints that follow, both already cost time:

- **No TypeScript parameter properties** (`constructor(private readonly x: T)`) in code the worker loads. Node's strip-only type stripping refuses them — it removes types, it does not transform. Biome flags them too.
- **An ssh2 `Channel` is a `Duplex`, not a `net.Socket`.** Node's HTTP agent calls `setKeepAlive`/`setNoDelay`/`ref` on whatever `createConnection` returns, and the failure surfaces as an unreadable `TypeError` from inside `node:_http_agent`. The executor stubs the missing methods and disables agent keep-alive.

**Infrastructure code is not done when it typechecks.** Anything touching SSH,
Swarm, Nixpacks or Traefik must be run against a real VPS before it is considered
working. If you cannot test it, say so plainly instead of implying it works.

**Never hand-roll the deploy swap.** Use `docker service update --update-order
start-first --update-failure-action rollback` with a `HEALTHCHECK` on the service.
The whole point of running Swarm is that this behaviour is already correct.
Verified on a real VM: a broken image fails its healthcheck, Swarm rolls back on
its own, and the previous version keeps serving without interruption.

**Swarm's safety net expires. `--update-monitor` is not a tuning knob — it is the
definition of "when is a deploy considered final".** Measured on a real VM, same
image, only the crash delay changed:

| App dies at | vs `monitor=45s` | Outcome |
|---|---|---|
| 25 s | inside | Swarm counts the failure and **rolls back**. Previous version serves again. |
| 90 s | outside | Update reported `completed`. Previous task already drained. Restart policy relaunches **the broken image**, forever. Measured availability: **9/12 requests over 60 s**, indefinitely. |

Raising the window is not the fix: it makes every deploy wait that long before it
is confirmed, and a crash one minute later still slips through. Real apps die
under load after minutes, not seconds — so the outside case is the *common* one.

**Therefore the worker keeps watching after the deploy "succeeds."** Swarm's
monitor stays short so deploys stay fast; Noddle observes the service for a few
minutes afterwards, and if the task restarts repeatedly it marks the deployment
failed and redeploys the previous image **from its own database**. This is
something Swarm structurally cannot do: Noddle has the whole deployment history,
Swarm retains one previous spec. Ship it with the deploy loop in Phase 1 — the
one-click rollback already scheduled there is the same machinery.

**A failed deploy exits 0.** `docker service update --update-failure-action
rollback` returns 0 after a *successful rollback* — the deploy failed, the command
succeeded. Measured. So the worker must never infer deploy success from the exit
code; read `docker service inspect --format '{{.UpdateStatus.State}}'` and treat
`rollback_completed` / `rollback_paused` as failure. Getting this wrong means the
dashboard reports a green deploy while the old version is what's actually serving.

**Never `cmd | grep -q` in remote scripts.** They run under `set -o pipefail`.
`grep -q` exits at the first match, the producer takes SIGPIPE (141), and pipefail
turns that into a failed pipeline. It is a *race* — whether the producer finished
writing first — so the same code passes and fails on alternate runs. This cost a
Phase 0 run: `docker info | grep -q 'Swarm: active'` intermittently re-ran
`swarm init` on an already-swarmed node. Query state directly instead:
`docker info --format '{{.Swarm.LocalNodeState}}'`. Same trap with `| head`.

**Capping a build: cap the builder, not the build command.**

`docker build --memory` / `--cpus` **does not work.** BuildKit accepts the flags and
ignores them ([moby/buildkit#1362](https://github.com/moby/buildkit/issues/1362);
[docker/buildx#644](https://github.com/docker/buildx/issues/644) proposes deleting
them outright). A cap written that way is a silent no-op — the worst failure shape,
because the build succeeds and the protection looks like it works. `nixpacks build`
also has **no `--docker-opts` flag** — only `--docker-host`, `--docker-tls-verify`,
`--docker-cert-path`.

The working shape, implemented in `scripts/spike-local.sh`:

1. `nixpacks build . --out .` — generate the Dockerfile, don't build. `--out .` (into the source dir), never a separate directory: nixpacks writes only `.nixpacks/` and does **not** copy your source, while the Dockerfile it generates does `COPY .nixpacks/…`. So `.nixpacks` has to sit inside the build context or the build dies on a missing COPY.
2. `docker buildx create --driver docker-container --driver-opt memory=… --driver-opt cpu-quota=…`
3. `docker buildx build --builder … --load --progress=plain -f DIR/…/Dockerfile CONTEXT`

The cgroup lands on the buildkitd container, so it covers all build work.
`--progress=plain` is required: buildx's default TTY renderer rewrites the screen
and is unusable as an SSE stream.

**Never pass `--apt` or `--pkgs` to nixpacks.** On 1.41.0 both flags wipe the
generated nix `overlays` list. The Node provider declares
`railwayapp/nix-npm-overlay` there, and that overlay is what *defines* `npm-9_x`.
Drop it and every Node build dies with `error: undefined variable 'npm-9_x'`.
Re-injecting the overlay through `nixpacks.toml` does not help — `--apt` clobbers
it regardless. Measured:

| invocation | `overlays` | Node build |
|---|---|---|
| `nixpacks build . --out .` | overlay present | works |
| `… --apt wget` | `[ ]` | fails |
| `… --pkgs wget` | `[ ]` | fails |

Consequence for the product: **there is no way to inject a package through the
nixpacks CLI.** Anything Noddle needs inside a user's image has to come from the
base image, or from a build stage Noddle controls — never from a nixpacks flag.

**Swarm gotchas that will silently break things:**
- `HEALTHCHECK` needs a binary **inside** the image, and it runs under a **non-login `sh -c`**. Measured in `nixpacks:ubuntu-1745885067`: `curl` is present at `/bin/curl` and on `PATH`; `wget` is absent; `node` is **not** on `PATH` because it lives in the nix profile that only a *login* shell sources. So the healthcheck uses `curl`, and a `node -e` healthcheck would fail just as silently as `wget`. Either way it presents as a Traefik routing bug.
- `docker service create/update --no-resolve-image` for locally-built images. Without it Swarm tries to resolve the digest against a registry, fails, warns, then falls back to the tag — slow and noisy on one node.
- **Local builds pin a service to the node that built it.** The image exists nowhere else, so Swarm's scheduler cannot move it. Phase 2 multi-server means "each service is built and stays on its assigned node", not "Swarm places services freely". Free placement needs the registry work currently parked in Phase 4.
- Traefik reads labels on the **service**, not the container
- `traefik.http.services.<name>.loadbalancer.server.port` is **required** — Traefik cannot infer the port in Swarm mode
- Traefik v3 uses `--providers.swarm`; v2 used `--providers.docker.swarmMode`. Check against the pinned version.
- **Traefik must be pinned to >= 3.6.** Below that its embedded Docker SDK is fixed at API 1.24, which Docker Engine 29 rejects (minimum 1.40). The Swarm provider then never connects, discovers nothing, and every request 404s — while the service, its labels and the overlay network are all correct, and Traefik itself answers on :80. The most misleading failure in the chain: nothing looks broken, and the only evidence is one retrying line in Traefik's own log. Fixed upstream in milestone 3.6 ([traefik#12253](https://github.com/traefik/traefik/issues/12253)); the spike pins an exact patch.
  **The widely-repeated `DOCKER_API_VERSION` workaround does not work.** Measured on v3.3: the variable is present in the container's environment, the container restarts, and Traefik still announces 1.24. Do not reach for it — upgrade the version.
  Noddle installs Docker *itself*, so it owns both halves of this compatibility pair. Let either float independently and fresh installs break.
- `docker stack deploy` **ignores** `build:` and conditional `depends_on`. Build first, deploy the resulting image.
- Swarm does **not** solve distributed storage. Stateful services (Postgres, Redis) are pinned with placement constraints and local volumes. A database lives on exactly one node, explicitly.

**Secrets** — SSH keys, env var values, webhook URLs are encrypted at rest with
AES-256-GCM from an app-level `APP_KEY`. Never log decrypted values. Prefer
`docker secret` over env vars so nothing leaks into `docker inspect`.

**Deployment logs** — stream to SSE and persist to disk or object storage. Do not
write one Postgres row per log line.

---

## UI rules

The design system is deliberately constrained. Treat these as limits, not defaults:

- ~4 type sizes, 1 accent color plus neutrals, 2 elevation levels max
- One project dashboard: every service's status visible at a glance, no drilling in
- Deploy is one button, always visible — never nested in a dropdown
- Env vars are an inline-editable table with a visible diff before save, not a raw textarea
- Logs live-tail by default, errors highlighted, build noise collapsed into expandable groups
- Advanced Docker/Traefik knobs are **not** exposed as UI fields. One raw config override textarea per service is the escape hatch.

---

## Working conventions

- Small, focused commits. One concern per commit.
- Do not add dependencies without saying why.
- Do not invent config options, env vars or feature flags that were not asked for.
- Do not scaffold files "for later." Build what the current phase needs.
- When something is genuinely ambiguous, ask one specific question rather than picking and moving on.
- When you are uncertain whether something works, say so directly. Confident wrong infra code is the main risk on this project.

---

## Code standards

Enforced mechanically by Biome via Ultracite — `bun run check` / `bun run fix`.
The prose reference lives in `AGENTS.md` at the repo root; it is not repeated
here so that this file stays what it is: the record of what has been *decided*
about Noddle, not a style guide.
