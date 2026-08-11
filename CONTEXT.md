# Noddle

Self-hosted deployment platform: point it at a git repo, it builds and runs the
app on a VPS you own, with HTTPS and a domain, from a dashboard. Restraint over
feature count — every screen answers "is it healthy" and "how do I ship".

## Language

### Platform

**Target server**:
A Linux host Noddle manages over SSH. The installer registers its own host as
target server #1.
_Avoid_: Node (ambiguous with Swarm/JS), machine, box, VPS (when meaning the
managed record)

**Self host**:
The installer's own machine registered as the first target server (`isSelf`).
Display fact only — deploy path is the same SSH executor as any other target.
_Avoid_: Localhost special case, control plane host

**Project**:
A tenant-facing grouping of services the user deploys and operates together.

**Environment scope**:
The inventory of Services, Stacks, and Databases in one environment —
membership + status for the dashboard grid.
_Avoid_: dashboard groups (when meaning one environment's list)

**Service**:
A deployable unit (image + Swarm service + Traefik route) belonging to a project.
_Avoid_: App (when meaning the Swarm unit), container (the runtime instance)

**Database**:
A managed engine instance (Postgres, Redis, …) Noddle provisions as a stateful
Swarm service with placement and volumes.
_Avoid_: DB service (ambiguous with app Service)

**Deployment**:
One attempted (or completed) ship of a service to a target — recorded in Noddle's
history so rollback can return to *any* previous image.
_Avoid_: Release, ship (as nouns for the record)

**Preview**:
An ephemeral environment for a pull request, derived from the same deploy path as
production services.

### Access & build

**SSH key library**:
Vault of SSH keys (`ssh_keys`) from which target access keys are chosen —
agentless; nothing installed on the target.
_Avoid_: Agent, sidecar, daemon on target

**Build**:
Producing a Docker image on the **target server** (Nixpacks or Dockerfile), under
a resource-capped buildx builder.
_Avoid_: CI build (Noddle builds on the target, not in GitHub Actions)

**Registry**:
Image store used so a built image can leave the build node (embedded registry in
Phase 4+). Without a push, a local image pins the service to that node.

### Runtime

**Job**:
One unit of queued work on the deploy queue — a ship, a backup, a teardown, a
prune. Every Job kind shares that queue on purpose: its concurrency of 1 is what
keeps a build, a push and a prune from racing.
_Not_: a Deployment, which is the row in the history. Deploying enqueues a Job;
most Job kinds produce no Deployment at all.

**Swarm manager**:
The single node allowed to run `docker service create/update`. Extra servers join
as workers only.
_Avoid_: Leader (Raft), control node

**Post-deploy watch**:
Noddle's continued observation after Swarm's `--update-monitor` window — late
crashes trigger rollback from Noddle's deployment history.
_Avoid_: Healthcheck (that's Swarm's), monitor window (Swarm's only)

**Rollback**:
Redeploying a previous image from Noddle's deployment history (not only Swarm's
single previous spec).

**Terminal**:
An interactive shell opened from the dashboard over WebSocket — either on a
target server (SSH) or inside a running container (`docker exec`).
_Avoid_: Console (ambiguous with browser/devtools), SSH session (when meaning
the product feature)
