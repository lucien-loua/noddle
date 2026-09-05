# Noddle

Noddle deploys applications and databases to a server you own, from a single dashboard. Restraint over feature count — every screen answers "is it healthy" and "how do I ship".

## Language

### Platform

**Target server**: A Linux host Noddle manages over SSH. The installer registers its own host as target server #1. _Avoid_: Node (ambiguous with Swarm/JS), machine, box, VPS (when meaning the managed record)

**Dashboard**: The web application an operator signs in to — `apps/dashboard`, the container `noddle-dashboard-1`, the image `noddle-dashboard`. It is the only surface Noddle exposes to a person; every other process is a worker or a dependency. _Avoid_: web, UI, frontend, console

**Self host**: The installer's own machine registered as the first target server (`isSelf`). Display fact only — deploy path is the same SSH executor as any other target. _Avoid_: Localhost special case, control plane host

**Project**: A tenant-facing grouping of services the user deploys and operates together. A project is never without at least one environment.

**Environment**: A named slice of a Project (production, staging, …) that holds Services, Stacks and Databases. _Avoid_: stage, namespace

**Default environment**: The environment a Project is born with. It cannot be deleted or renamed. _Avoid_: production (the usual name, not the concept)

**Environment scope**: The inventory of Services, Stacks, and Databases in one environment — membership + status for the dashboard grid. _Avoid_: dashboard groups (when meaning one environment's list)

**Service**: A deployable unit (image + Swarm service + Traefik route) belonging to a project. _Avoid_: App (when meaning the Swarm unit), container (the runtime instance)

**Database**: A managed engine instance (Postgres, Redis, …) Noddle provisions as a stateful Swarm service with placement and volumes. _Avoid_: DB service (ambiguous with app Service)

**Resource**: A Service, Stack or Database — the union the dashboard grid, topology and their shared action handling address as one thing (`ResourceRow`, `run(target, action)`). Naming the union lets one module own status, availability and dispatch across all three kinds instead of each kind carrying its own copy. _Avoid_: item, entity

**Dependency**: A declared edge from a Service to what it consumes — a Database, or another Service. Created by attaching, it states usage and never deploy order. _Avoid_: link, relation, connection (that's the DSN)

**Deployment**: One attempted (or completed) ship of a service to a target — recorded in Noddle's history so rollback can return to _any_ previous image. _Avoid_: Release, ship (as nouns for the record)

**Preview**: An ephemeral environment for a pull request, derived from the same deploy path as production services.

### Access & build

**SSH key library**: Vault of SSH keys (`ssh_keys`) from which target access keys are chosen — agentless; nothing installed on the target. _Avoid_: Agent, sidecar, daemon on target

**Build**: Producing a Docker image on the **target server** (Railpack or Dockerfile), under a resource-capped BuildKit daemon Noddle owns. _Avoid_: CI build (Noddle builds on the target, not in GitHub Actions)

**Repository hook**: The webhook Noddle registers on a GitLab project, for one connection. GitLab only — a GitHub App carries one hook for the whole App. Several Services can deploy one repository and share the hook. _Avoid_: project hook (GitLab's own word; Project here means something else)

**Registry**: Image store used so a built image can leave the build node (embedded registry in Phase 4+). Without a push, a local image pins the service to that node.

**Deploy engine**: The module that turns a resolved spec into a running Service, Stack or Database — build, push, placement, Traefik labels, service update, Swarm verdict. It owns no database and no queue: the worker resolves rows and secrets into the spec, and acts on the verdict it gets back. Operating something already running (remove, restart, scale, registry trust and pruning) is a separate entry, not a deploy. _Avoid_: deployer, build pipeline, orchestrator

### Runtime

**Job**: One unit of queued work on the deploy queue — a ship, a backup, a teardown, a prune. Every Job kind shares that queue on purpose: its concurrency of 1 is what keeps a build, a push and a prune from racing. _Not_: a Deployment, which is the row in the history. Deploying enqueues a Job; most Job kinds produce no Deployment at all.

**Swarm manager**: The single node allowed to run `docker service create/update`. Extra servers join as workers only. _Avoid_: Leader (Raft), control node

**Swarm verdict**: Swarm's accept-or-refuse decision on a spec change, read from `UpdateStatus.State` once it stops being `updating` — never inferred from an exit code, since a successful rollback exits 0. A fresh create has no `UpdateStatus` at all: that counts as accepted, and convergence is read from the tasks instead. _Avoid_: deploy result, exit code, update status (the raw field, not the decision)

**Post-deploy watch**: The period Noddle observes a Deployment after Swarm has accepted it — a ship, a Rollback, or a watch recovery — past Swarm's `--update-monitor` window. Late crashes in that window trigger Rollback from Noddle's deployment history. _Avoid_: Healthcheck (that's Swarm's), monitor window (Swarm's only)

**Rollback**: Redeploying a previous image from Noddle's deployment history (not only Swarm's single previous spec).

**Pending action**: The window between firing a lifecycle action from the dashboard and the row confirming it. The resource still reads its OLD status — a stop leaves a Service `running` for a second or two — so the screen shows the pending label instead. It ends when the status moves, when `updatedAt` moves for a restart (which never changes status), when the server function refuses the action, or after 60s so a job that never lands cannot pin a badge forever. _Avoid_: optimistic update, in-flight

**Terminal**: An interactive shell opened from the dashboard over WebSocket — either on a target server (SSH) or inside a running container (`docker exec`). _Avoid_: Console (ambiguous with browser/devtools), SSH session (when meaning the product feature)
