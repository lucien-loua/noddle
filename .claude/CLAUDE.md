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
server).

**Cette course a été faite, le 2026-08-03** — VPS Debian 13 public,
`noddle.ouestlabs.xyz`, vrai Let's Encrypt. Voir « HTTPS » en Phase 2.

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

**Webhooks faits et vérifiés en direct, 7/7 (`verify-webhook.ts`).** Un
secret par service ou par pile (`webhook_secret_encrypted`), montré UNE SEULE
fois à sa génération — comme un jeton d'API, jamais relu ensuite, même
chiffré : le panneau ne peut que le régénérer. `queueServiceDeploy` /
`queueStackDeploy` (`apps/web/src/lib/deploy-queue.server.ts`) factorisent ce
que `triggerDeploy`/`triggerStackDeploy` faisaient déjà, pour que le
déclenchement manuel (session requise) et le webhook (signature requise à la
place) déposent EXACTEMENT la même ligne et le même job — un webhook n'est
pas un chemin parallèle, c'est une autre porte d'entrée vers le même
mécanisme.

Le récepteur (`api/webhooks/service/$serviceId`, `api/webhooks/stack/$stackId`)
lit le corps BRUT avant tout parsing JSON — la signature se vérifie sur les
octets exacts, pas sur une relecture. GitHub signe (`X-Hub-Signature-256`,
HMAC-SHA256) ; GitLab envoie le secret en clair (`X-Gitlab-Token`) : les deux
sont acceptés, comparés à temps constant dans les deux cas. Les deux
partagent le même schéma de payload push (`ref`/`after`) pour cet événement,
donc un seul lecteur suffit. Une branche différente de celle configurée
répond 200 (ignoré) plutôt que 4xx : GitHub retenterait sinon indéfiniment un
événement qui n'a simplement rien à faire ici.

Vérifié contre une vraie VM : signature invalide refusée (401), branche
différente ignorée sans rien déployer, et un push signé sur la bonne branche
déclenche un build réel qui converge — avec le SHA du payload (`after`)
effectivement utilisé comme commit à checkout, pas seulement HEAD de la
branche.

**Bases de données en un clic faites et vérifiées, 6/6 (`verify-database.ts`)
puis en direct dans un vrai navigateur.** Nouvelle table `databases` :
Postgres ou Redis, un conteneur officiel, un volume nommé épinglé au serveur
qui le porte — même raison que `services`/`stacks` : une image (ici locale
au registre officiel, mais le volume, lui, est toujours local à CE nœud) ne
se déplace pas toute seule, Swarm ne résout pas le stockage distribué.
Contrairement à `services`/`stacks`, aucun historique de déploiement : une
base a une seule version en cours, jamais de build, jamais de rollback.
`waitForRunningTask`/`readUpdateState`/`isDeployAccepted` sont réutilisés tels
quels depuis `swarm.ts` — ce sont des sondages dockerode génériques, pas un
mécanisme lié au chemin HTTP/Traefik des services.

**Le mot de passe n'est jamais montré, pas même une fois.** Contrairement au
secret d'un webhook (qui doit sortir vers un tiers, donc s'affiche une fois),
une base de données n'a aucun tiers externe à qui le donner : « Attacher à un
service » construit la chaîne de connexion et l'écrit CHIFFRÉE directement
comme variable d'environnement du service choisi, entièrement côté serveur —
réutilise le mécanisme `env_vars` déjà existant plutôt que d'inventer un
système d'attachement séparé. Le navigateur ne voit jamais que « Attaché ».

**HTTPS fait et vérifié contre le VRAI Let's Encrypt, le 2026-08-03.** VPS
public Debian 13 (72.62.88.7), domaine `noddle.ouestlabs.xyz`, installation
par le chemin documenté. Étagé exprès : d'abord le serveur de STAGING, puis
seulement après la production — la production n'autorise que 5 échecs de
validation par heure et 50 certificats par semaine et par domaine, et brûler
ce quota sur la première exécution d'un code jamais lancé aurait bloqué
`ouestlabs.xyz` pour la semaine.

Mesuré, pas déduit : certificat émis pour le plan de contrôle
(`Verification: OK`, `ssl_verify_result=0`, émetteur `CN=YR1`, pas de marqueur
STAGING), redirection 80→443, et une application déployée par le worker sur
son propre sous-domaine servie en HTTPS avec son propre certificat — ce qui
prouve que `CERT_RESOLVER` traverse bien `deploy.ts` → `routeLabels` jusqu'aux
labels Swarm (`entrypoints=websecure`, `tls.certresolver=le`).

| Vérifié | Comment | |
|---|---|---|
| Ports 80/443 joignables depuis l'extérieur | listeners jetables + `curl` depuis une autre machine | ✓ |
| Émission staging puis production | logs lego + `openssl x509` | ✓ |
| Certificat réellement de confiance | `curl` SANS `-k`, `ssl_verify_result=0` | ✓ |
| Le défi HTTP-01 survit à la redirection globale | `/.well-known/acme-challenge/…` répond **404, pas 301** | ✓ |
| Application déployée en HTTPS bout en bout | build nixpacks → Swarm → Traefik → cert | ✓ |
| `acme.json` survit à un redémarrage | redémarrage complet : **0** nouvelle demande | ✓ |

**Reste pour la Phase 2 : rien.** Les quatre chantiers du plan initial
(multi-serveur, déploiements Compose, webhooks, bases de données) sont faits
et vérifiés contre du réel, et HTTPS l'est aussi. Phase 3 : sauvegardes vers
S3, notifications, graphiques de ressources, équipes/RBAC.

### Phase 3 — état au 2026-08-04

**Sauvegardes et restauration vers S3 faites et vérifiées contre du réel**,
jusqu'au navigateur. Cible de développement : **RustFS** en conteneur, un vrai
service compatible S3 (`localhost:9000`).

| Vérifié | Contre | |
|---|---|---|
| `packages/shared` — schémas | pur, deux runtimes | 22/22 |
| `packages/ssh-executor` — `execStream` | VM Multipass | Node 13/13, Bun 11/12 |
| `packages/backup-store` | RustFS réel, deux runtimes | 12/12 de chaque côté |
| `apps/worker` — sauvegarde | VM + RustFS | 11/11 |
| `apps/worker` — restauration | VM + RustFS | 12/12, Postgres ET Redis |
| Boucle complète au navigateur | 3 processus + VM + RustFS | destination → sauvegarde → restauration |

**Deux décisions prises pour ce chantier :**

| Décision | Choix | Pourquoi |
|---|---|---|
| Chemin du dump | **Par le worker ; le dumper vient de l'image de la base** | `pg_dump` est dans `postgres:17-alpine`, `redis-cli` dans `redis:7-alpine`. Rien à provisionner en face (tient « agentless, SSH only »), et le dumper a par construction la version du serveur — un binaire posé sur l'hôte dériverait dès qu'une base naîtrait en `postgres:18`. Les octets traversent le réseau deux fois : assumé, c'est du bouclage sur la machine unique, et pousser depuis la cible ferait voyager la clé S3 vers chaque serveur |
| Destination S3 | **Une par installation**, unicité tenue par la BASE | Le cas courant est une machine, un compartiment ; « par base » imposerait un sélecteur sur chaque écran pour toujours. L'ouvrir plus tard est une migration additive (`destination_id` nullable), la refermer non. Vérifié dans les deux sens : index unique + contrainte `check` contre le contournement par `singleton=false` |

**`Bun.s3` a été évalué et écarté.** Il existe bien (mesuré), mais le module
`bun` n'est pas résolvable sous Node, et c'est le worker — sur Node par
décision actée — qui téléverse. Il ne retirerait donc aucune dépendance, il
ajouterait une SECONDE implémentation S3 pour la même opération. Ne pas le
reproposer.

**Le point de correction du chantier**, miroir exact de « a failed deploy
exits 0 » : **un dump tronqué se téléverse parfaitement.** Mesuré contre
RustFS — un flux qui se termine proprement mais incomplet produit un objet S3
valide au contenu faux, et rien côté stockage ne peut le détecter. Seul le
code de sortie du dumper tranche. D'où `execStream()` en forme à
CONSOMMATEUR : les flux ne sont pas rendus à l'appelant, qui pourrait oublier
d'attendre le code. Vérifié en direct : `pg_dump` tué en plein vol sort en
137, la sauvegarde passe `failed` et l'objet incomplet est retiré du
compartiment.

À l'inverse, un flux qui ÉMET une erreur fait annuler l'envoi multipart par le
SDK : aucun objet publié, aucun envoi laissé ouvert. Mesuré aussi — c'est ce
qui autorise à ne PAS écrire de code de nettoyage sur ce chemin.

**Restaurer est la seule opération irréversible du produit**, et l'écart avec
le rollback d'un service est porté par le code, pas par un texte de
confirmation : l'objet est vérifié présent dans le compartiment AVANT toute
action destructrice, une sauvegarde de sûreté est prise juste avant
(`kind='pre_restore'`), seule une sauvegarde `completed` est restaurable, et
`confirmName` est revérifié CÔTÉ SERVEUR — une boîte de dialogue ne protège
que les clients qui l'affichent.

**Le piège Redis, en deux temps, tous deux mesurés sur une vraie VM :**

- La base tourne en `--appendonly yes`, donc au démarrage Redis charge l'AOF
  et **ignore le RDB**. Poser `dump.rdb` et redémarrer ne restaure RIEN : la
  clé ajoutée après la sauvegarde était toujours là.
- Purger l'AOF ne suffit pas non plus — sans AOF, Redis 7 démarre **vide** et
  en fabrique un neuf ; il ne se rabat jamais sur le RDB. C'est le pire des
  deux : une restauration « réussie » qui rend une base vide.

La réponse retenue est un **conteneur jetable** monté sur le même volume,
démarré en `--appendonly no` (il charge donc le RDB), puis AOF activé à chaud
pour qu'il le réécrive depuis les données chargées. Le vrai service redémarre
ensuite avec ses arguments habituels, inchangés — aucun `docker service
update --args` sur le service de l'utilisateur.

Une hypothèse écartée par la mesure, à ne pas rouvrir : **`docker cp` vers un
conteneur ARRÊTÉ atteint bien le volume monté.** Ce n'était pas la cause.

**Trois défauts que SEUL un vrai navigateur a montrés** (tous invisibles au
curl, parce que les vérifications précédentes appelaient `checkDestination`
sans jamais LIRE le message rendu) :

- Une **clé secrète fausse** s'affichait « compartiment injoignable :
  `Unknown: UnknownError` » — le message accusait le mauvais champ et
  n'apprenait rien. `HeadBucket` répond **sans corps**, donc le SDK n'a ni code
  ni message S3 à exposer. Le statut HTTP, lui, est toujours là : 403 →
  « identifiants refusés », 404 → « compartiment introuvable ».
- « de la sauvegarde **du** à l'instant » : `relativeTime` rend déjà une
  locution complète.
- La case « style chemin » était annoncée **deux fois** par l'arbre
  d'accessibilité — un `<label htmlFor>` enveloppant la `Checkbox` de shadcn,
  qui porte déjà son propre rôle.

Et un faux positif noté pour ne pas le rouvrir : **l'arbre d'accessibilité
n'affiche pas la valeur d'un input qui a un `placeholder`**, ce qui donne
l'impression qu'un formulaire se vide après un échec. Les valeurs sont
intactes — vérifier dans le DOM avant de « corriger ».

**Planification et rétention faites et vérifiées, 11/11
(`verify-backup-schedule.ts`).** Trois rythmes (`off`/`daily`/`weekly`), pas
d'expression cron : les boutons Docker et Traefik ne sont pas exposés comme
champs d'interface, et un cron est un langage à part entière dans un
formulaire.

**UN passage qui interroge Postgres, PAS un planificateur BullMQ par base.**
Un planificateur par base devrait être créé, modifié et supprimé à chaque
changement de réglage, et le jour où Redis est vidé — ce qui arrive, c'est un
cache — toutes les planifications disparaîtraient en silence. L'état vit dans
la base ; un passage qui redémarre reprend où il en était. Même forme que
`sweepWatch`, même raison.

Une base est due si sa dernière sauvegarde **réussie** remonte à plus que son
intervalle. « Réussie » et pas « tentée » : sinon une base cassée cesserait
d'être sauvegardée dès le premier échec, exactement quand on en a le plus
besoin.

La purge tourne APRÈS l'enregistrement du succès, jamais avant — purger
d'abord réduirait la fenêtre pendant laquelle il reste quelque chose à
restaurer si le dump en cours échoue — et elle n'a pas le droit de faire
échouer une sauvegarde qui, elle, a réussi. Les deux tests qui comptent ne
sont pas « le passage s'exécute » mais : **une base PAS due est-elle
épargnée** (un planificateur qui déclenche tout le temps est aussi faux qu'un
qui ne déclenche jamais) et **la rétention supprime-t-elle l'OBJET** et pas
seulement la ligne — une ligne effacée sans son objet donne un compartiment
qui grossit sans fin, invisible depuis le dashboard.

**Un quatrième défaut vu seulement au navigateur**, de la même classe que les
trois précédents : la bascule de rythme était optimiste mais n'était pas
annulée sur refus du serveur. Activer « Chaque jour » sans destination
configurée laissait le bouton sélectionné alors que la base gardait son ancien
rythme — **l'écran affirmait une protection qui n'existait pas.** Corrigé par
`onMutate`/`onError`. La règle générale : toute bascule optimiste doit être
annulée sur échec, sinon le dashboard ment sur l'état réel, ce qui est
précisément ce qu'il existe pour éviter.

**Notifications faites et vérifiées** — `packages/notifier` 14/14 sur les deux
runtimes contre un vrai récepteur HTTP, `verify-notify.ts` 8/8 contre un vrai
Postgres, et la boucle complète dans un navigateur.

Trois types de canaux (webhook générique, Discord, Slack), un seul mécanisme
d'envoi, seule la forme de la charge utile change. Aucune dépendance ajoutée :
`fetch` suffit, et un client Discord ne ferait qu'emballer un POST tout en
ajoutant une bibliothèque à suivre. Pas de SMTP — délivrabilité, identifiants
et dépendance, pour un cas qu'un webhook couvre déjà.

**Plusieurs canaux permis**, contrairement à la destination S3 : la raison qui
imposait l'unicité là-bas (un sélecteur sur chaque écran) ne s'applique pas à
une liste dans un écran de réglages.

**On notifie ce qui va MAL.** Déploiement échoué, bascule annulée par Swarm,
reprise par la surveillance, sauvegarde échouée. `notify_success` existe mais
est décochée par défaut : prévenir de chaque succès est le moyen le plus sûr
de rendre le canal invisible le jour où il porte un échec. `deploy_reverted`
et `watch_reverted` restent DISTINCTS, comme en base.

**L'équivalent du « dump tronqué » ici : une notification qui échoue en
silence est pire que pas de notification** — on se croit surveillé. D'où
`last_error`/`last_success_at` sur chaque canal, un état « jamais sollicité »
qu'on ne confond pas avec un succès, et « Éprouver » qui envoie un VRAI
message. Le code HTTP est lu, pas supposé : un webhook Discord révoqué répond
404 sans que la requête échoue au sens réseau.

**Et symétriquement : `notify` ne lève JAMAIS**, try/catch posé une fois dans
le module plutôt que recopié à chaque appel. Un Discord injoignable ne
transforme pas un déploiement réussi en déploiement échoué — même règle que la
purge de rétention.

**`https` exigé pour Discord et Slack, `http` accepté pour un webhook
générique.** Chez les deux premiers une URL `http` est une faute de frappe qui
échouerait au premier envoi ; pour le troisième, un service interne en clair
(`http://10.0.0.5:5678`) est un cas légitime et fréquent en auto-hébergé, et
l'interdire ne sécuriserait personne — ça pousserait à contourner Noddle.

**Deux défauts que seul le navigateur a montrés :**

- **Les erreurs de validation Zod s'affichaient en JSON brut** — le tableau
  d'issues sérialisé, avec crochets, guillemets et champ `code`. C'est la
  forme du transport de TanStack Start, qu'on ne peut pas changer sans
  renoncer à la validation partagée ; elle se défait donc à l'affichage
  (`errorMessage` dans `lib/format.ts`). **Cela concernait tous les
  formulaires validés côté serveur**, pas seulement celui des canaux.
- **Le message de panne était celui du RUNTIME** : Node dit « fetch failed »,
  Bun « Unable to connect… ». Or les deux envoient — le web éprouve, le worker
  émet — donc le même canal en panne s'affichait différemment selon qui avait
  essayé, et en anglais. Ne reste que la distinction utile : trop tard, ou pas
  du tout.

**Discord et Slack réels : non poursuivi, par décision.** Il faudrait une URL
de webhook réelle, qui est un secret porteur, et ce n'est pas la priorité
actuelle. Les formes restent asserties contre ce que leurs API documentent et
le transport est réel ; on part du principe que ça fonctionne plutôt que de
garder ce point ouvert dans chaque passe de vérification.

**Graphiques de ressources faits et vérifiés, le 2026-08-04**
(`apps/worker/src/verify-metrics.ts`, 9/9 contre une vraie VM + un vrai
Postgres). Deux nouvelles tables, `server_metrics` et `service_metrics` :
UN passage qui interroge chaque serveur `connected` toutes les minutes,
même forme que `sweepWatch`/`sweepBackups` et pour la même raison — l'état
vit dans Postgres, un Redis vidé ne fait pas disparaître la collecte.

**Un trou reste un trou, ici aussi.** Un serveur injoignable n'écrit
AUCUNE ligne plutôt qu'un zéro : un zéro se lirait « la machine était
calme », le contresens exact que ce principe — déjà posé pour les
sauvegardes et les notifications — existe pour éviter. Mesuré : un serveur
mort au milieu de la collecte ne produit pas de ligne, et n'empêche pas
l'échantillonnage des autres. Côté service, le CPU vient de `docker stats
--stream=false` : `precpu_stats` est déjà peuplée par Docker en un seul
appel (mesuré, pas supposé), et un delta système nul — un conteneur qui
vient de démarrer — ne produit pas 0 % mais rien du tout, même règle.

**TanStack Charts**, cohérent avec le reste de la pile (Router, Query,
Table, Form) plutôt qu'une bibliothèque de graphes de plus. Les
sparklines (`resource-graphs.tsx`, réutilisées telles quelles par
`service-resources.tsx` dans le détail d'un service) donnent un `null`
explicite à chaque interruption plutôt que de compter sur une
interpolation — `lineY` traite `y = null` comme une rupture, convention
héritée d'Observable Plot. La palette catégorielle (`--chart-1`, gris
clair pensé pour des surfaces pleines) était illisible en trait de 1,2 px
sur une carte blanche ; une série UNIQUE suit donc `currentColor` /
`text-muted-foreground`.

**RBAC fait et vérifié, le 2026-08-04**
(`apps/web/src/verify-permissions.ts`, 9/9). Construit sur
`createAccessControl` du plugin `admin` de better-auth plutôt que sur une
table de rôles maison — le plugin apporte le modèle ressource × action, la
création de comptes, `setRole`, `removeUser` et surtout
`checkRolePermission`, SYNCHRONE côté client, donc un bouton interdit se
masque sans aller-retour serveur. Quatre rôles (`viewer`, `deployer`,
`admin`, `owner` — `owner` identique à `admin` aujourd'hui, mais protégé
contre sa propre suppression, voir plus haut) sur sept ressources
(`service`, `database`, `backup`, `envVar`, `server`, `notification`,
`user`). `envVar` isolé des services bien qu'il en dépende : les valeurs y
sont chiffrées, et « quelqu'un qui doit pouvoir livrer n'a pas à voir les
secrets » — `deployer` a `service:deploy` mais pas `envVar:read`.

**Deux points, pas un.** `requirePermission` côté serveur EST la
permission ; `useCan`/`checkRolePermission` côté client n'est qu'une
politesse — ne pas proposer un bouton dont on sait qu'il sera refusé. Les
deux évaluent la MÊME table de permissions, importée du même fichier pur
(`lib/permissions.ts`, aucun accès base, chargé des deux côtés), donc
l'interface ne peut pas diverger de ce que le serveur autorise réellement.
`verify-permissions.ts` lit les FICHIERS de `server/` plutôt qu'une liste
tenue à la main : il énumère chaque `createServerFn({ method: "POST" })`
et échoue si son corps n'appelle pas `requirePermission`. Un contrôle
absent est sinon invisible — la fonction ne lève rien, ne casse rien.

**Passe de finition, le 2026-08-04.** Trois défauts trouvés en vérifiant
le masquage contre un vrai navigateur, aucun visible au typecheck :

- **Le dialogue « Créer un compte » de /comptes ne s'ouvrait pas** —
  intermittent par construction, donc invisible en test rapide. Cause :
  `relativeTime()` lit `Date.now()` au rendu ; le serveur écrit « il y a
  9 min », le client réhydrate une seconde plus tard avec « il y a
  10 min ». React ne voit pas un horodatage, il voit un désaccord entre
  les deux rendus et rejette l'arbre entier pour le reconstruire — un
  clic tombé pendant cette reconstruction s'enfonce (l'état `:active` est
  du CSS) sans qu'aucun gestionnaire soit attaché. `resource-row.tsx`
  portait déjà l'échappatoire (`suppressHydrationWarning`) sur ce cas
  précis, mais elle n'avait pas suivi jusqu'aux cinq écrans ajoutés en
  Phase 3. Centralisé dans un composant `RelativeTime` unique plutôt que
  reposé site par site — c'est exactement l'oubli qui a coûté ce bug.

- **`getEnvVars` n'exigeait AUCUNE permission.** Un `GET`, donc hors de
  portée de `verify-permissions.ts`, qui n'énumère que les fonctions
  mutantes (`POST`) — le trou invisible que ce script existe pour éviter,
  juste hors de son rayon. N'importe quel compte connecté, `deployer`
  compris, pouvait lire les variables NON secrètes en clair : `isSecret`
  protège les valeurs, pas la LISTE. Corrigé par
  `requirePermission({ action: "read", resource: "envVar" })`. Trouvé en
  vérifiant le masquage client, pas en le construisant — le bouton n'était
  qu'une politesse, le vrai trou était côté serveur.

- **Le premier passage de masquage (4c85149) n'avait couvert que
  /comptes.** Le dashboard (`/`) ne recevait même pas `role` depuis
  `beforeLoad` — rien n'y pouvait appeler `useCan`. Un lecteur voyait
  « Nouveau », « Attacher », « Déployer », « Rejouer », l'onglet Variables,
  le bouton webhook et les actions de sauvegarde, tous refusés côté
  serveur mais jamais retirés de l'écran. Même trou sur /notifications,
  /sauvegardes et /serveurs. Fermé en filant `role` jusqu'à chaque
  composant qui porte une action, même mécanisme que /comptes — vérifié en
  changeant de compte dans le même navigateur : un lecteur créé pour
  l'occasion ne voit plus aucune des actions ci-dessus, sans régression
  côté owner.

**Correction à la première rédaction de cette section : les graphiques de
ressources n'étaient PAS encore vérifiés au navigateur avec des données
peuplées** — seul le mécanisme worker (`verify-metrics.ts`, 9/9) l'était,
et l'environnement de dev local montrait « aucun relevé » (badge rouge)
partout, une collecte réellement bloquée plutôt qu'un simple manque de
recul. Cause : **la clé SSH du serveur enregistrée en base était chiffrée
sous un `APP_KEY` antérieur** — probablement une rotation de clé entre deux
sessions — donc `decryptSecret` échouait à chaque passage de collecte.
Corrigé en ré-chiffrant la clé déjà présente sur disque
(`~/.ssh/id_ed25519`, celle que `verify-live.ts` utilise déjà par
convention) sous l'`APP_KEY` courant, sans jamais faire transiter la clé en
clair par un formulaire ni l'afficher — seul le fait de l'opération est
journalisé.

Vérifié ensuite en direct, jusqu'au bout : le graphique du SERVEUR se
peuple (charge, mémoire, disque, tous non nuls, badge « relevé à
l'instant ») ; un vrai service a été poussé sur la VM (dépôt `git init`
minimal, même technique que `verify-live.ts`, sans passer par le
formulaire dont le schéma Zod refuse `file://`) et déployé par le chemin
réel (`queueServiceDeploy`, la même fonction que le bouton Déployer) —
l'onglet Ressources du service affiche CPU et Mémoire réels, à la fois
pour owner et pour un lecteur créé pour l'occasion, confirmant au passage
que le masquage RBAC tient sur un service qui a de vraies données à
montrer, pas seulement sur un écran vide.

**Discord et Slack réels : non poursuivi, par décision** — voir plus haut.

**Reste pour la Phase 3 :** rien. Graphiques de ressources et RBAC sont
faits et vérifiés contre du réel, jusqu'au navigateur pour les deux.

**Préalable connu pour les ÉQUIPES (multi-tenancy), distinct du RBAC ci-dessus
et toujours ouvert.** Le RBAC répond à « qui a le droit de faire quoi » —
fait. Il ne répond pas à « qui voit les ressources de QUI », parce que la
question ne se pose pas encore : une installation Noddle reste UNE
organisation, tout le monde voit tout, aucune table ne porte de colonne de
propriété. `requirePermission` tranche une action contre un rôle, jamais
contre un propriétaire.

Le jour où les équipes arrivent, ce n'est donc PAS une fonction à corriger
mais **toutes** : chacune devra porter un prédicat de tenancy, dans le `where`
de la lecture ET dans celui de l'écriture. Le noter ici parce que c'est le
genre de dette qu'un audit signale une fonction à la fois, ce qui donne
l'illusion d'un correctif local alors que c'est une migration de modèle.

**Dette repérée, hors chantier :** `ENGINE_SPECS` (`apps/worker/src/database.ts`)
passe le mot de passe Redis dans `Command`, donc il est lisible en clair dans
`docker service inspect` — antérieur à ce chantier, et en tension avec la
règle « prefer `docker secret` ».

**Trois défauts que SEUL un vrai navigateur sur l'installation publique a
montrés**, tous les trois invisibles en local et invisibles au curl :

- **Personne ne pouvait se connecter.** `BETTER_AUTH_URL` vide laisse
  better-auth déduire l'origine de la requête ; Traefik terminant le TLS, le
  processus web voit du HTTP en clair sur le port 3000 et déduit
  `http://<domaine>`, alors que le navigateur envoie `Origin: https://…`.
  Toute requête POST partait en 403 `INVALID_ORIGIN`. **La même requête passe
  en 200 sans en-tête `Origin` — c'est-à-dire au curl.** La vérification au
  curl réussissait donc pour la mauvaise raison, y compris le test « le verrou
  à un seul compte fonctionne ». `docker-compose.tls.yml` fixe désormais
  `BETTER_AUTH_URL: https://${NODDLE_DOMAIN}`.

- **La feuille de style répondait 404 à chaque chargement.** Tailwind v4
  détecte ses sources seul et élague avec le `.gitignore` ; l'image Docker n'a
  pas de `.git` (exclu par `.dockerignore`), donc `dist/` cesse d'être élagué
  et la passe SERVEUR de `vite build` scanne le bundle CLIENT écrit trois
  secondes plus tôt. Elle génère une feuille différente et écrit SON empreinte
  dans le HTML rendu côté serveur — feuille jamais émise. Mesuré : client
  `styles-CrpERSPK.css`, serveur `styles-EVvdB83F.css`, même build. La page
  restait sans style jusqu'à ce que le JS client injecte la vraie, donc
  l'écran finissait correct et le défaut ne se voyait que dans la console.
  Corrigé par `@source not "../dist"` dans `styles.css`.

- **La machine n°1 restait « Provisionnement… » pour toujours.**
  `adopt-host.ts` n'écrivait jamais `status`, qui restait à `pending` — sur un
  serveur qui construisait et déployait déjà. C'est le cas mono-machine, donc
  le cas courant, et un écran dont le seul travail est de dire « est-ce que ça
  va » se trompait chez tout le monde. Corrigé en relevant les mêmes faits que
  `provisionServer`, par le MÊME chemin (SSH réel puis socket Docker à travers
  lui) : marquer `connected` sans vérifier aurait été faux dans l'autre sens,
  et c'est ici que le chemin de bouclage doit être exercé pour la première
  fois.

**Mise à jour testée en direct, le 2026-08-04 : le VPS public tournait un
commit d'avant la Phase 3 (HTTPS seulement), cinq migrations en retard.**
La reconstruction a d'abord échoué : `apps/web/Dockerfile` et
`apps/worker/Dockerfile` ne copiaient jamais `packages/backup-store` ni
`packages/notifier` — ajoutés en Phase 3, jamais reportés dans l'étape
manifeste (`COPY .../package.json`) que `bun install --frozen-lockfile`
exige pour résoudre le workspace ENTIER. Invisible en local et en CI,
puisque ni l'un ni l'autre ne reconstruit cette image à chaque changement
— seule une reconstruction sur un checkout postérieur à leur ajout le
révèle. `apps/web/Dockerfile` manquait aussi leur SOURCE complète, requise
par `vite build` qui les importe réellement ; `apps/worker/Dockerfile` copie
tout `packages/` en vrac donc n'avait que le trou du manifeste. Corrigé
dans les deux fichiers.

**Le dépôt étant privé, le VPS ne clone pas depuis GitHub** — son remote
`origin` pointait déjà vers un bundle git local (`/root/noddle.bundle`),
posé lors de la course HTTPS plutôt que de donner un jeton GitHub à la
machine cible. Mise à jour reproduite à l'identique : `git bundle create`
en local, `scp`, puis `git fetch`/`reset --hard` sur le bundle côté VPS.
Trois modifications non commitées trouvées sur place avant de toucher à
quoi que ce soit (`styles.css`, `adopt-host.ts`, `docker-compose.tls.yml`)
— confirmées identiques à ce que `main` contient déjà avant de les
écraser, pour ne pas perdre un correctif appliqué à la main et jamais
repoussé.

### Phase 4 — registre d'images, le 2026-08-04

**Fait et vérifié contre DEUX vraies VM Multipass, 24/24
(`apps/worker/src/verify-registry.ts`).** C'est le premier chantier de la
Phase 4, et celui qui débloque les autres : jusqu'ici une image construite
n'existait que sur SON nœud, donc chaque service était épinglé par une
contrainte `node.id==…` et Swarm ne pouvait rien replanifier.

Le test qui compte : une image construite sur le worker, le nœud vidé
(`docker node update --availability drain`), la task **replanifiée sur le
manager** — une machine qui n'a jamais construit cette image — et qui sert
du HTTP. Sans registre, Swarm n'avait nulle part où aller.

| Décision | Choix | Pourquoi |
|---|---|---|
| Registre | **Embarqué dans la pile du plan de contrôle**, `registry:3.1.1` épinglé | Un registre externe demanderait un compte tiers et des identifiants collés AVANT le premier déploiement, ce qui casse « une commande sur n'importe quel VPS ». Même forme que la destination S3 : un par installation |
| TLS | **AC générée par l'installateur**, déposée dans `/etc/docker/certs.d/<hôte:port>/ca.crt` sur chaque nœud | `insecure-registries` exigerait un redémarrage du démon, donc — en mode Swarm où `live-restore` n'existe pas — une coupure de toutes les tasks du nœud. Un certificat ACME derrière Traefik ne marcherait qu'avec un domaine, et donnerait deux chemins de code dont un seul serait jamais exercé |
| Adresse | **`<manager.host>:5000`**, figée dans le `.env` à la première installation | Ce n'est pas une nouvelle hypothèse réseau : les workers rejoignent déjà le cluster par `${manager.host}:2377`. Et elle est inscrite dans chaque `image_tag` de l'historique — la recalculer ferait mentir les déploiements passés le jour où `hostname -I` répond autre chose |
| Auth au tirage | **`X-Registry-Auth` dans la spec Swarm**, pas de `docker login` par nœud | Le manager chiffre les identifiants dans la spec et les distribue à ses agents ; ce sont EUX qui tirent, sur des nœuds où Noddle n'ouvre aucune session |
| Placement | **Décidé PAR IMAGE, sur la référence** (`isPortableImage`) | Ce n'est pas une heuristique : c'est le fait que Docker lui-même lit pour savoir où tirer. Une image du registre est libre, une image locale reste épinglée |

**La migration est gratuite, et c'est le point de conception.** Un rollback
vers un déploiement d'AVANT le registre porte un tag non qualifié, reste donc
épinglé au bon nœud et continue de fonctionner, pendant que les déploiements
neufs sont libres. Rien à re-pousser, aucune ligne d'historique à réécrire,
aucun drapeau à lire. Vérifié explicitement (`verify-registry.ts`).

`REGISTRY_HOST` absent = comportement d'avant, à l'identique. Une installation
dont le code est à jour mais la pile pas encore redémarrée se comporte comme
avant, sans rien casser.

**Trois choses mesurées AVANT d'écrire le code, parce qu'elles décidaient
de la conception :**

- **`/etc/docker/certs.d` est relu à CHAQUE requête, sans redémarrage du
  démon.** Sur un démon en place depuis trois jours : push refusé en
  « x509: certificate signed by unknown authority », dépôt de l'AC, push
  accepté, `ActiveEnterTimestamp` identique. C'est ce qui permet de migrer
  une installation qui tourne sans couper une seule application.
- **Rien sur une Ubuntu 24.04 nue ne produit du bcrypt**, seule forme que
  le registre accepte : `htpasswd` n'est pas installé, `openssl passwd -5`
  rend du SHA-256 crypt (`$5$`), et `registry:3` n'embarque pas htpasswd.
  Docker, lui, est garanti présent — d'où `docker run --rm -i httpd:2-alpine
  htpasswd -Bin`, en `-i` pour que le mot de passe ne passe pas par l'argv
  d'un `docker run`, visible dans `ps`.
- **Une image nixpacks de 929 Mo pèse 245 Mo dans le registre** (couches
  compressées, ~26 %), et la couche de base est PARTAGÉE entre toutes les
  versions et toutes les applications — une seconde application n'a coûté
  que ~1 Mo. C'est ce qui rend une rétention à dix versions bon marché.

**Le défaut du chantier, invisible au typecheck et invisible au second
déploiement : `docker.createService(spec)` appelé avec UN seul argument
laisse `auth` valoir la spec entière** (branche `else if (!opts && !callback)`
de dockerode), que docker-modem encode en base64 dans `X-Registry-Auth`. Le
démon n'y trouve aucun identifiant, et l'agent qui tire répond « pull access
denied… no basic auth credentials » — un déploiement qui ne converge pas en
180 s, dont le message ne désigne pas la cause.

`Service.prototype.update` extrait bien `opts.authconfig` dans ce même cas.
L'asymétrie fait que SEULE une création de service déclenche le défaut : le
premier déploiement d'un service, jamais les suivants. Chaque méthode reçoit
donc la forme qui marche pour elle. **Ne pas « harmoniser » les deux appels
sans relire ce paragraphe.**

**La rétention fait partie du chantier, pas d'un suivant.** Dix versions par
service, comptées en TAGS DISTINCTS et non en lignes — un rollback crée une
ligne de plus avec le même tag, et compter les lignes purgerait des images
encore jeunes. Le déploiement courant n'est jamais candidat, même sorti de la
fenêtre : rejouer une vieille version la rend courante sans la rendre récente.

**Supprimer un manifeste ne libère RIEN.** Mesuré deux fois : le tag disparaît
de `tags/list`, le volume ne bouge pas d'un octet. Seul `registry
garbage-collect --delete-untagged /etc/distribution/config.yml` rend les octets
(359 Mo repris sur 364, en vérification). Sans lui, la rétention donnerait un
dashboard propre et un disque qui se remplit quand même — exactement le défaut
qu'elle corrige, et la même leçon que « supprimer la ligne sans supprimer
l'objet » des sauvegardes.

Le GC passe par la **file des déploiements**, en concurrence 1 : il collecte
les couches qu'aucun manifeste ne référence, et une couche EN COURS D'ENVOI est
exactement dans ce cas.

**Assumé et à dire : « revenir à n'importe quelle version antérieure » devient
« aux dix dernières ».** L'alternative n'était pas « toutes » mais « jusqu'à ce
que le disque soit plein », limite que rien n'annonce.
`deployments.image_purged` garde la ligne d'historique — quel commit a tourné
quand n'a pas à disparaître parce qu'on a récupéré du disque — et retire le
bouton « Redeploy », qui serait un échec certain.

**Deux choses que le registre casse ailleurs, et qu'il fallait corriger dans le
même chantier :**

- **La collecte de métriques devenait aveugle.** `sampleServer` partait de
  `services.server_id` ; un service déplacé n'aurait produit AUCUNE ligne, et
  le dashboard aurait affiché « aucun relevé », badge rouge, sur un service en
  parfaite santé. Le contresens que la règle du trou existe pour éviter, sauf
  qu'il aurait été fabriqué par nous. On part maintenant de ce qui TOURNE sur
  le nœud (un `listContainers`, label `com.docker.swarm.service.name`).
- **`services.server_id` ne veut plus dire que « où ça se construit ».**
  `deployments.node_id` relève où la task tourne réellement, et l'écran
  n'affiche les deux que lorsqu'ils DIFFÈRENT. `null` quand on ne sait pas —
  jamais l'identifiant Swarm brut, qui n'informe personne.

**L'AC du registre ne vaut QUE pour le registre.** `fetch` aurait obligé à
`NODE_EXTRA_CA_CERTS`, donc à une confiance élargie au processus entier — S3
et webhooks de notification compris. `node:https` prend la chaîne par requête.
Et ça rend les pannes lisibles : `fetch` échoue en « fetch failed » quoi qu'il
arrive, le même message opaque déjà relevé sur les notifications.

**Ce que la vérification NE couvre pas :** `verify-registry.ts` monte SON
registre avec les mêmes commandes openssl qu'`install.sh`, reproduites et non
partagées — un helper commun ferait passer le test et l'installateur par le
même code, et le test cesserait de pouvoir détecter une divergence. L'
installateur se vérifie donc séparément, par une vraie installation.

**Conséquence pour les installations existantes : la mise à jour DOIT repasser
par `install.sh`**, qui est idempotent. Un `docker compose up` seul trouverait
`/etc/noddle/registry` vide, et Docker fabriquerait un répertoire à la place du
certificat attendu.

**Piège d'ESSAI, payé une fois : `install.sh` refait lui-même
`git fetch origin "$NODDLE_REF"` puis `checkout`, et `NODDLE_REF` vaut `main`
par défaut.** Poser une branche dans `$NODDLE_DIR` avant de lancer le script ne
suffit donc pas — il la remplace par `main`. Et l'échec est trompeur :
`git checkout` écrit un NOUVEL inode, alors que bash garde son descripteur
ouvert sur l'ancien. **Le script qui s'exécute est celui de la branche, le
compose sur disque celui de `main`.** Constaté exactement ainsi — la section
registre tournait (l'AC était générée), et `docker compose up -d` ne créait
aucun conteneur de registre, sans la moindre erreur et avec un code de sortie
0. Pour éprouver une branche : `NODDLE_REF=<branche> bash install.sh`.

**Piles Compose et bases de données restent ÉPINGLÉES**, et c'est délibéré :
un fichier compose peut déclarer des volumes, et un volume ne se déplace pas.
Elles poussent quand même au registre.

**Le répertoire de build est `/var/lib/noddle/builds`, PAS `/opt/noddle`.**
`fetchSource` commence par un `rm -rf` dessus ; tant qu'il vivait dans
`/opt/noddle`, ce `rm -rf` visait l'intérieur de l'installation Noddle — sur la
machine auto-hébergée, la seule chose qui ne se reconstruit pas.
`assertWipableDir` (build-engine) refuse en plus tout chemin à moins de trois
segments, à segment vide ou contenant `..` : même philosophie qu'`assertNotFlag`
à côté, le moteur ne fait pas confiance à ses appelants.

**Le trou de placement `sameConnection` était à QUATRE endroits, et je n'en ai
corrigé qu'un au premier passage.** À noter parce que l'erreur n'est pas le bug
mais la méthode : après avoir identifié un motif fautif, faire le `grep` avant
de le déclarer réglé.

Le motif `sameConnection ? undefined : nodeId` traitait la contrainte de
placement comme un no-op quand le serveur de la ressource ÉTAIT le manager.
Vrai sur un cluster à UN nœud, faux dès qu'un worker a rejoint : la ressource
perdait sa contrainte alors que son image — ou son volume — n'existe que là.
Présent dans `deploy.ts`, `compose.ts` (deux sites) et `database.ts`.

**Il ne s'est révélé que parce que le cluster de dev est passé à deux nœuds.**
`verify-stack.ts` passait 10/10 en Phase 2 sur une machine seule, où la
contrainte manquante était sans conséquence ; il est tombé à 2/1 dès qu'un
worker a rejoint, sur « pull access denied » — Swarm avait planifié la pile sur
le nœud qui n'avait pas l'image. **Conséquence de méthode : un test
mono-machine ne prouve rien sur le placement.**

Le cas de `database.ts` est le plus grave et n'était couvert par AUCUN test :
le volume nommé d'une base n'existe que sur son nœud, et Swarm ne résout pas le
stockage distribué. Déplacée, la base démarrerait sur un volume VIDE — sans
erreur, avec l'air de fonctionner. `verify-database.ts` assert désormais la
contrainte, et retire les VOLUMES entre deux exécutions : un volume nommé
survit à `removeService`, donc la seconde exécution provisionnait un mot de
passe neuf sur des données existantes et échouait en accusant le code (même
piège que celui déjà relevé pour `verify-backup.ts`).

**Passe UI, le 2026-08-04.** L'interface était « trop basique », ne
respectait pas les principes de regroupement, et des dialogues débordaient
du viewport. Trois défauts structurels, tous vérifiés au navigateur en
clair ET en sombre :

- **`DialogContent` n'avait AUCUNE contrainte de hauteur ni de
  défilement.** Un formulaire long poussait l'en-tête ET le pied hors de
  l'écran : titre illisible, bouton de soumission inatteignable. Mesuré
  sur « Connect a Compose stack » (dix champs) à 1280×760. Corrigé au
  point de passage unique — `max-h-[85dvh]`, colonne flex, `DialogBody`
  qui porte le défilement — donc pour TOUS les dialogues d'un coup.
  `dvh` et non `vh` : sur mobile la barre d'URL fausse `vh`.

- **Le détail se dépliait SOUS sa ligne** et repoussait tous les autres
  services hors de l'écran — il cassait la seule chose que le dashboard
  doit faire. Passé sur des routes dédiées (`/services/$id`,
  `/stacks/$id`, `/databases/$id`) : cliquer NAVIGUE, la liste ne bouge
  jamais, et on la retrouve à l'identique au retour. Les chargeurs
  réutilisent les lectures du dashboard plutôt que d'ajouter des server
  functions par id — même requête, mêmes gardes, rien de plus à inscrire
  dans `verify-permissions.ts`.

- **Le masquage RBAC de la veille ne couvrait que /comptes** (déjà noté
  plus haut) ; cette passe a aussi révélé que `getEnvVars`, un GET, n'avait
  aucune garde. Voir la section correspondante.

**Pièges déjà payés, à ne pas repayer :**

- **`overflow-y-auto` ROGNE l'anneau de focus** des premier et dernier
  champs : l'anneau déborde du cadre du champ, et le conteneur le coupe au
  ras. Marges négatives + padding équivalent (`-mx-6 px-6 -my-2 py-2`)
  rendent la place sans décaler le contenu d'un pixel. Vaut pour tout
  conteneur défilant qui contient des champs.

- **Base UI garde le panneau d'onglet SORTANT monté** le temps de sa
  transition de fermeture (`data-ending-style`, plus `inert`). Tant que le
  panneau n'a pas de hauteur propre, ça ne se voit pas ; dès qu'il porte
  `flex-1`, l'ancien contenu GARDE sa place et le nouveau s'affiche
  dessous, poussé hors de l'écran. `data-ending-style:hidden` le
  neutralise. Le défaut n'existait pas avant que les onglets défilent
  chacun pour eux-mêmes — c'est le genre de régression qu'un changement de
  mise en page révèle dans un composant qu'on n'a pas touché.

- **`Button` de Base UI suppose un `<button>` NATIF.** Lui passer un lien
  par `render` fait lever un avertissement en console — à raison, la
  sémantique de bouton se perd. `nativeButton={false}` déclare l'intention
  (« un lien habillé en bouton ») au lieu de la subir.

- **`scroll-fade` / `scroll-fade-x` / `no-scrollbar` viennent de
  `shadcn/tailwind.css`**, déjà importé par `styles.css` — ils sont
  disponibles partout, il n'y a rien à définir. Cherché à tort dans
  `styles.css`, où ils n'apparaissent pas.

- **`scroll-fade` est un `mask-image`, donc il ronge le DÉCOR de l'élément
  sur lequel on le pose** — bordure, fond et rayon compris, pas seulement
  le texte. Sur le même div qu'une `border`, le cadre se rongeait en haut
  et en bas dès qu'on faisait défiler ; sur `TabsList`, la pastille grise
  se dissolvait sur les côtés et les onglets flottaient. **Règle : le
  décor et ce qui défile sont deux éléments.** Un cadre statique n'a rien
  à faire disparaître.

  Quand le décor EST ce qui défile (la pastille d'un rail d'onglets),
  deux niveaux ne suffisent pas, il en faut trois — décor → conteneur
  masqué → contenu transparent. C'est ce que fait `TabRail`
  (`components/tab-rail.tsx`) ; passer par lui plutôt que de poser
  `scroll-fade-x` sur un `TabsList`.

- **Deux tableaux enveloppaient `Table` dans leur PROPRE
  `overflow-x-auto`** alors que le composant en porte déjà un : deux
  conteneurs de défilement imbriqués, dont l'extérieur gagnait, donc le
  `scroll-fade` posé sur le composant ne servait à rien.

- **Trois pièges payés d'un coup en enveloppant `TabsList` pour ce masque**,
  tous invisibles au typecheck et trouvés en MESURANT dans le navigateur, pas
  en regardant :

  - `overflow-x-auto` seul ne suffit pas : dès qu'un axe passe en `auto`, CSS
    force l'autre de `visible` à `auto`. Le rail défilait verticalement.
    `overflow-y-hidden` à côté n'est donc pas redondant. (`ui/table.tsx` a la
    même forme — vérifié, sans conséquence : rien n'y contraint la hauteur.)
  - **tailwind-merge ne déduplique pas deux portées de variante différentes**,
    et la version préfixée gagne en spécificité. `tabsListVariants` pose sa
    hauteur en `group-data-horizontal/tabs:h-9` : un `h-7` nu ne la bat pas,
    il faut reprendre le MÊME préfixe. Vaut pour tout `cva` dont on rejoue une
    propriété déjà posée sous variante.
  - **Envelopper un composant lui fait perdre ses propres classes de boîte.**
    `TabsList` porte `w-fit` ; le div ajouté autour ne l'avait pas, et comme
    `Tabs` est une colonne flex, il a hérité d'`align-self: stretch` — le rail
    barrait l'écran entier derrière quatre onglets.

- **Base UI déplace le focus des onglets avec `preventScroll`** (sinon chaque
  flèche ferait sauter la page), donc le navigateur n'amène PAS l'onglet visé
  dans la vue. Mesuré : les flèches atteignaient le dernier onglet, la zone
  restait à `scrollLeft` 0, le focus se posait 23 px hors du bord — invisible,
  au clavier, là où l'on ne peut pas rattraper à la souris. Un
  `scrollIntoView({ block: "nearest", inline: "nearest" })` sur `onFocus` le
  répare, et c'est lui qui donne enfin un effet à `scroll-padding`.

- **`$SUDO` vide dans un TABLEAU bash n'est pas ignoré, contrairement à `$SUDO`
  non quoté.** `install.sh` construisait `COMPOSE=("$SUDO" docker compose …)` :
  en root, `SUDO=""` et `"${COMPOSE[@]}"` passe une CHAÎNE VIDE comme nom de
  commande — bash répond `: command not found` et l'installation s'arrête juste
  avant de démarrer la pile. Invisible jusqu'ici parce que toutes les
  installations d'essai tournaient sur une VM Multipass sous un utilisateur
  avec `sudo`, où `SUDO="sudo"` ; le premier VPS loué, où l'on est root, l'a
  déclenché immédiatement. Le préfixe ne doit être ajouté que s'il est non
  vide. **Corollaire : `curl | bash` en root et `sudo bash` sont deux chemins
  distincts, et seul le second était testé.**

- **Une redirection posée sur l'ENTRYPOINT rend TOUS les routeurs de cet
  entrypoint inatteignables.** `docker-compose.tls.yml` gardait un routeur
  attrape-tout en clair sur `web`, avec un commentaire affirmant qu'il servait
  encore le dashboard par l'IP nue tant que le DNS n'avait pas propagé. C'est
  faux : la redirection s'applique AVANT le routage, donc `http://<ip>/` part
  en 301 vers `https://<ip>/`, que le certificat — émis pour le NOM — ne
  couvre pas (`openssl` verify code 20). Le routeur est inerte ; cessé de le
  redéclarer, rien n'a changé (redirection, HTTPS et exemption ACME
  identiques). **Conséquence produit : une fois un domaine configuré, il n'y a
  plus d'accès de secours par l'IP.** C'est le bon compromis — le dashboard
  prend un mot de passe admin — mais il faut le savoir.

- **Dans un override Compose, `command:` est REMPLACÉ mais `labels:` est
  FUSIONNÉ** — y compris écrits tous les deux en liste. Compose normalise les
  labels en table et fusionne les clés, là où il écrase la liste `command`.
  Conséquence concrète : les drapeaux de provider doivent être recopiés dans
  `docker-compose.tls.yml` (sinon ils disparaissent), alors qu'un routeur
  Traefik déclaré dans `docker-compose.yml` survit à la fusion même si
  l'override ne le mentionne pas. Constaté sur `docker compose config` : on
  croyait avoir retiré le routeur en clair, il était toujours là.

- **Le défi ACME HTTP-01 n'est PAS cassé par la redirection globale
  80→443** : Traefik enregistre son routeur de challenge en interne, avec une
  priorité supérieure à la redirection d'entrypoint. Vérifié en tapant
  `/.well-known/acme-challenge/<jeton>` sur le port 80 : la réponse est **404,
  pas 301**. À noter parce que le log lego seul ne le prouve PAS — Let's
  Encrypt suit les redirections et ignore la validité du certificat pendant un
  HTTP-01, donc « Validations succeeded » serait apparu dans les deux cas.

- **Changer `caserver` sans effacer `acme.json` ne bascule pas de staging à
  production.** Le compte ACME stocké est lié au CA qui l'a émis ; le résolveur
  garde le même nom (`le`). Le volume doit être vidé à la bascule. En sens
  inverse, `acme.json` DOIT persister en usage normal : redémarrage complet de
  la pile mesuré à **0** nouvelle demande de certificat, ce qui est exactement
  ce qui protège le quota.

- **`pkill -f <motif>` sur une machine distante se tue lui-même** si le motif
  apparaît dans sa propre ligne de commande — c'est le cas quand la commande
  arrive par SSH. La session tombe, `ssh` sort en 255, et aucune sortie ne
  revient : ça ressemble à une panne réseau. Écrire le motif de façon à ne pas
  se matcher (`[h]ttp.server`).

- **`redis-cli -u "redis://:<mdp>@hôte:port"` (utilisateur vide) échoue avec
  `WRONGPASS`, alors que le MÊME mot de passe passé en `-a <mdp> -h <hôte>`
  fonctionne.** Sans ACL, le parseur d'URI a besoin de l'utilisateur explicite
  `default` pour reconnaître le mot de passe — `redis://default:<mdp>@…`.
  Mesuré contre une vraie instance avant correction ; la chaîne de connexion
  que « Attacher à un service » écrit utilise donc `default`, jamais un
  utilisateur vide.
- Le premier passage de `verify-webhook.ts` a envoyé un `after` inventé dans
  le payload simulé : `git checkout` a échoué (code 128, "couldn't find
  remote ref") — comportement CORRECT du worker, pas un bug du webhook. Un
  test qui simule un push doit utiliser un SHA qui existe réellement dans le
  dépôt, jamais une valeur de convenance.

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

- **`pg_dump` n'a besoin d'AUCUN mot de passe** quand on l'exécute DANS le
  conteneur officiel : le `pg_hba` généré met les connexions par socket locale
  en `trust`. Le secret ne touche donc jamais une ligne de commande. Redis n'a
  pas cet échappatoire — son mot de passe passe par `REDISCLI_AUTH` et jamais
  par `-a`, qui l'exposerait dans l'argv du `docker` distant.
- **`redis-cli --rdb -` écrit un RDB pur sur stdout** (magie `REDIS0012`), tout
  son bavardage partant sur stderr. Vérifié avant d'être utilisé.
- **Un banc d'essai doit échouer bruyamment sur son propre MONTAGE.**
  `execArgv` rend un code de sortie que rien n'oblige à lire : un
  `CREATE TABLE` échouant sur une table déjà présente passait inaperçu, et le
  test mesurait un dump minuscule en croyant en mesurer un gros. Corollaire :
  un **volume nommé SURVIT à `removeService`**, donc chaque exécution héritait
  des tables de la précédente.
- **Des données de test « volumineuses » doivent être INCOMPRESSIBLES.** Deux
  essais ratés avant d'y arriver : `repeat('x', 400)` passait de 360 Mo à
  3,8 Mo, puis `repeat(md5(…), 10)` répétait le MÊME md5 dix fois par ligne.
  Sans ça le dump se terminait avant la coupure et le test annonçait un défaut
  qui n'existait pas.
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
3. **Phase 3** — backups to S3-compatible storage, notifications, resource graphs, RBAC (**tous faits et vérifiés**, voir plus haut). Teams/multi-tenancy — distinct from RBAC, see the known prerequisite above — remains open.
4. **Phase 4** — registry-based builds (**fait et vérifié**, voir plus haut), preview environments per PR, audit log, CLI.

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
- **Local builds pin a service to the node that built it.** The image exists nowhere else, so Swarm's scheduler cannot move it. **Plus vrai depuis la Phase 4 pour les SERVICES** : l'image est poussée au registre embarqué et le placement est libre — mais la contrainte demeure, conditionnelle, pour toute image non poussée (rollback vers une version d'avant le registre), et pour les piles Compose et les bases, qui portent des volumes. Voir `placementFor` dans `deploy.ts`.
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

- ~4 type sizes, 2 elevation levels max
- **Monochrome, préréglage shadcn TEL QUEL.** La règle disait « 1 accent color plus neutrals » ; l'accent n'a jamais été posé, et la question a été tranchée le 2026-08-04 : on garde le gris. Un accent a été proposé, calculé en oklch et vérifié en contraste — puis écarté. Ne pas le reproposer sans demander.
- **Le texte visible est en ANGLAIS**, URLs comprises. Les commentaires de code et ce fichier restent en français.
- One project dashboard: every service's status visible at a glance. Le DÉTAIL (logs, historique, variables, ressources, webhook) vit sur sa propre page ; c'est le tableau de bord qui ne doit rien cacher, pas le détail qui doit tenir dedans — voir la passe du 2026-08-04.
- Deploy is one button, always visible — never nested in a dropdown
- Env vars are an inline-editable table with a visible diff before save, not a raw textarea
- Logs live-tail by default, errors highlighted, build noise collapsed into expandable groups
- Advanced Docker/Traefik knobs are **not** exposed as UI fields. One raw config override textarea per service is the escape hatch.
- **Rien qui existe dans le préréglage ne se réécrit à la main.** Un `<select>` natif habillé d'une classe, un fil d'Ariane en `<nav>`, un lien stylé en bouton : à chaque fois le résultat divergeait du reste (hauteur, rayon, mode sombre, anneau de focus). `bunx shadcn add <composant>` d'abord, on compose ensuite.
- **L'espacement libellé/champ appartient à `Field`**, pas à l'appelant. Quinze champs utilisaient un `<div>` nu et se retrouvaient sans le `gap-3` du composant — libellé collé à son input, différemment selon l'écran.

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
