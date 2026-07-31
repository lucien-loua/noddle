# Noddle — Self-Hosted Deployment Platform Spec

A minimalist, self-hostable PaaS. Positioning: **same power, far less UI noise**. Every screen should answer "is it healthy" and "how do I ship" without a click into a submenu.

---

## 1. Tech Stack


| Layer                                          | Choice                                                                                         | Why                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| App framework                                  | **TanStack Start**                                                                             | full-stack React, file-based routing via TanStack Router, server functions replace a separate API layer        |
| Data fetching / cache                          | **TanStack Query**                                                                             | wraps server functions, handles polling for live status                                                        |
| Tables (deployments, logs, env vars, servers)  | **TanStack Table**                                                                             | headless, fits a restrained design system                                                                      |
| Forms (service config, env vars, server setup) | **TanStack Form**                                                                              | schema-driven, pairs with Zod                                                                                  |
| Validation                                     | **Zod**                                                                                        | shared schemas client/server                                                                                   |
| ORM                                            | **Drizzle ORM** + Postgres                                                                     | typed, migration-friendly, lightweight                                                                         |
| Auth                                           | **better-auth**                                                                                | self-hosted, no external dependency, supports orgs/teams later                                                 |
| Job queue                                      | **BullMQ** + Redis                                                                             | deploy/build jobs are long-running, need retry + concurrency control                                           |
| Remote execution                               | **ssh2** (Node) over SSH, **dockerode** for Docker Engine API tunneled through SSH             | agentless — no daemon to install on target servers                                                             |
| Zero-config builds                             | **Nixpacks** (shelled out to)                                                                  | detects Node/Python/Go/etc, no Dockerfile required                                                             |
| Orchestration on target servers                | **Docker Swarm mode** (single node to start)                                                   | `docker service update` is a transactional deploy primitive: rolling update, health gate and rollback built in |
| Reverse proxy on target servers                | **Traefik** (Swarm provider)                                                                   | dynamic label-based routing, native Let's Encrypt                                                              |
| Realtime (logs, deploy status)                 | **SSE** via a TanStack Start server function stream (fallback: raw WebSocket server alongside) | simpler than WS for one-directional log tail                                                                   |
| Own app deploy                                 | **Docker Compose**                                                                             | Noddle itself ships as containers, installed by a single script                                                |


Runtime and package manager: Bun. Monorepo via the `workspaces` field in the root `package.json`, and no Turborepo/Nx at this scale.

One caveat to settle in Phase 0: Bun as a *package manager* is a free win, but Bun as the *runtime for* `apps/worker` is not yet proven for this workload. The worker depends on `ssh2` and `dockerode`, and `ssh2` carries optional native addons. Verify the worker's SSH and Docker paths run on Bun before building on top of them; if they don't, run `apps/worker` on Node and keep Bun everywhere else. Bun stays the package manager either way.

---

## 2. Monorepo Structure

```
/apps
  /web              -> TanStack Start app (UI + server functions)
  /worker           -> BullMQ worker process (build/deploy/backup jobs)
/packages
  /db               -> Drizzle schema + migrations, shared by web & worker
  /ssh-executor      -> SSH connection pool, remote docker command wrappers
  /build-engine      -> Nixpacks invocation, Dockerfile build, image push logic
  /proxy-config      -> Traefik label/config generation
  /shared            -> Zod schemas, types shared across packages
/installer
  install.sh         -> one-line curl|bash installer for the platform itself
  docker-compose.yml -> app + postgres + redis + traefik

```

Keep `web` and `worker` as separate deployable processes from day one — deploys are long-running (minutes), you don't want them blocking the request/response cycle of the dashboard. Even in v1, don't run builds in a server function.

---

## 3. Core Data Model (Drizzle schema, simplified)

```
users, sessions, organizations (via better-auth)

servers
  id, name, host, ssh_port, ssh_user, ssh_private_key_encrypted,
  status (connected/unreachable), docker_version, created_at

projects
  id, org_id, name

environments
  id, project_id, name (e.g. production, staging)

services
  id, environment_id, server_id, name,
  source_type (git | docker_image | compose),
  git_repo_url, git_branch, build_method (nixpacks | dockerfile | image),
  domain, port, status (running/stopped/deploying/crashed)

env_vars
  id, service_id, key, value_encrypted, is_secret

deployments
  id, service_id, status (queued/building/deploying/success/failed),
  commit_sha, triggered_by, started_at, finished_at

deployment_logs
  id, deployment_id, storage_url, byte_size, created_at
  -- Pointer only. Log text streams job → SSE → disk/object storage.
  -- Never one Postgres row per log line.

backups
  id, service_id, storage_target, schedule_cron, last_run_at, status

notifications_config
  id, org_id, type (discord/slack/email), webhook_url_encrypted

```

Secrets (SSH keys, env var values, webhook URLs) — encrypt at rest with a key derived from an app-level `APP_KEY` env var (AES-256-GCM). Never log decrypted values.

---

## 4. Deployment Engine (the core of the product)

Flow for a git-based deploy:

1. Webhook (or manual "Deploy" click) enqueues a `deploy` job in BullMQ with `service_id` + `commit_sha`.
2. Worker picks up job:
  - SSH into target `server`.
  - `git clone`/`fetch` the repo into a build directory on that server (or build in a local buildkit container and push to a registry — decide based on whether you want zero-downtime via image registry; **recommended: build locally on the target server first, registry-based builds are a v2 optimization**).
  - Run Nixpacks (`nixpacks build . --name <service>-<sha>`) if `build_method = nixpacks`, or `docker build` if Dockerfile present.
  - Stream build output line-by-line back over SSE to the dashboard AND persist to disk/S3.
  - On success: `docker service update --image <new> --update-order start-first --rollback-on-failure` (or `docker service create` on first deploy), with env vars injected and Traefik labels attached for routing + SSL.
  - The service definition carries a `HEALTHCHECK`. Swarm starts the new task, waits for it to report healthy, and only then drains the old one. If the new task never goes healthy, Swarm rolls back on its own.
  - Update `deployment.status`, `service.status`.
3. On failure: the old task is still serving. Mark the deployment failed and surface the last N log lines directly in the UI (not buried in a separate logs tab).

Health-gated swap is the single highest-value behaviour in the whole engine — a broken deploy silently killing a running service is the most common and most painful failure mode in this category of tool. **Do not hand-roll it.** The whole reason to run Swarm is that this one behaviour is already correct, including the edge cases (task starts, passes health, then dies 10s later) that bespoke stop-then-start logic tends to get wrong.

---

## 5. Reverse Proxy / Domains

- One Traefik instance per target server, deployed automatically when a server is added.
- Each service deploy generates Docker labels (`traefik.http.routers.*`) rather than editing a central config file — Traefik's Docker provider picks these up automatically via the Docker socket.
- SSL: Traefik's ACME resolver, cert storage on a persistent volume on the target server.
- Custom domains: user adds a domain to a service, app shows the DNS record to create, verifies via DNS lookup before enabling the route.

---

## 6. The Installer (one command, any VPS)

`install.sh` responsibilities, run via `curl -fsSL https://get.noddle.dev | bash` (domain not registered yet — see Still Open):

1. Detect OS (Ubuntu/Debian primarily, warn on others).
2. Install Docker + Docker Compose plugin if missing.
3. Create `/etc/noddle` for config, generate `APP_KEY` (encryption key) if not present.
4. Pull `docker-compose.yml` (app + Postgres + Redis + Traefik), prompt for:
  - domain for the dashboard itself
  - admin email/password (or defer to first-run setup wizard in the UI)
5. `docker compose up -d`, run DB migrations as a one-off container command.
6. Print the dashboard URL + a "run `docker compose logs -f` if something's wrong" hint.

Keep this idempotent — running it again should upgrade, not duplicate.

### The single-box case is the common case

"Install on any VPS with one command" means most users will run the control plane
**and** their apps on the same machine. The spec above assumes control plane + N
separate target servers, and those two models collide:

- The installer ships a Traefik (step 4). §5 deploys a Traefik per target server.
  On one box that's two Traefiks fighting over `:80`.
- A capped build still competes with Noddle's own Postgres/Redis for the same 2 GB.
- "Add server" pointed at `localhost` has no SSH story.

Unresolved. It changes the installer, the add-server flow and the proxy model, so
it needs an answer before Phase 1 hardens — not a Phase 3 detail.

---

## 7. UI Philosophy (the actual differentiator)

- **One dashboard, not five.** Project → list of services with a colored status dot, CPU/mem sparkline, last deploy time. No separate "overview" page you have to visit to know if things are fine.
- **Deploy is one button, always visible**, not nested in a dropdown.
- Env vars: a table with inline edit, a visible diff before you hit save, not a raw textarea of `KEY=value` lines.
- Logs: live-tail by default, errors auto-highlighted, collapse noisy build output into expandable groups instead of a flat wall of text.
- Settings pages: resist the urge to expose every Traefik/Docker knob in the UI. Advanced users can drop to a "raw config override" text field per service — this is how you stay minimal without losing power-user capability.
- Limit the design system: ~4 type sizes, 1 accent color + neutrals, no more than 2 elevation levels (flat + one shadow). This constraint is what actually produces "minimalist," not just fewer features.

---

## 8. Build Phases (realistic order, even with an agent doing the work)

**Phase 1 — Single server, git deploy, no frills**

- Auth, add one server via SSH, connect a git repo, Nixpacks build, deploy, Traefik routing, live log stream, start/stop/restart.

**Phase 2 — Make it a real product**

- Multi-server, Docker Compose deploys, env var UI, health-check-before-swap zero-downtime deploys, webhook-triggered deploys, database service templates (Postgres/Redis/MySQL one-click).

**Phase 3 — Operational maturity**

- Backups to S3-compatible storage, notifications (Discord/Slack/email), resource usage graphs, teams/RBAC, deployment rollback (redeploy previous image).

**Phase 4 — Polish/scale**

- Registry-based builds for faster redeploys, preview environments per PR, audit log, CLI companion tool.

Don't start Phase 2 features until Phase 1's deploy loop is boring and reliable — the deploy engine's correctness is what people trust the whole product on.

---

## 9. Architectural Decisions (settled)

### Build location: on the target server

Control plane and builds both run on the VPS. "Installable on any VPS with one command" is a core requirement, and building elsewhere implicitly needs either a machine that's always on or a container registry hop — both of which break the single-command promise.

The known cost of this choice: on a 2 GB VPS, a Next.js build will OOM and take your running production apps down with it. That's a real, common, painful failure, and fixing it is exactly the kind of thing that earns "better UX" without adding any UI.

So: **run every build under a hard resource cap** derived from server capacity, so a build can never starve running services. Surface it as one line in the UI — "builds capped at X GB" — not a settings panel.

The cap goes on the **builder**, not the build command. `docker build --memory`/`--cpus` is silently ignored by BuildKit, and `nixpacks build` has no `--docker-opts` flag at all. The working shape is a dedicated buildx builder on the `docker-container` driver with `--driver-opt memory=… --driver-opt cpu-quota=…`, fed a Dockerfile generated by `nixpacks build --out`. See `scripts/spike-local.sh` and the Hard rules in `.claude/CLAUDE.md`.

Building on a separate machine and pushing a finished image stays available as a Phase 4 config flag, not a v1 path.

### Orchestration: Docker Swarm mode, single node

Noddle runs every target server in Swarm mode, even when that "cluster" is one machine (`docker swarm init`).

The point is not clustering. The point is that `docker service update` is a **transactional deploy primitive**: rolling update, health gate, and automatic rollback are behaviours Docker already implements correctly, including the edge cases. Hand-rolled stop-then-start logic looks like 60 lines until you hit containers that pass their health check and then die, deploys that fail halfway, or a worker process that crashes mid-swap and leaves a service with zero running containers.

Concretely, this comes free instead of being written:

- `--update-order start-first` — new task up before old one drains (zero downtime)
- `HEALTHCHECK` gating — Swarm won't route traffic to an unhealthy task
- `--rollback-on-failure` / `docker service rollback` — one-command revert to the previous image
- Declarative desired state — Noddle's DB says what should run, Swarm reconciles toward it. Restarting the Noddle host doesn't lose track of anything.
- `docker secret` / `docker config` — first-class secret injection, no env vars leaking into `docker inspect`
- Multi-node later is `docker swarm join`, not a rearchitecture

**Where you will actually pay for this.** Swarm's bad reputation is almost entirely a *multi-node* story: overlay/VXLAN networking, stale service IPs, ingress routing mesh quirks. On a single node, none of that is in play — the network is a local bridge. Budget the pain for the day multi-node ships, not for v1.

Two things to know going in:

- Swarm is in maintenance at Docker — stable and maintained, but not gaining features. Fine for a deploy primitive, not something to build a differentiator on.
- Stateful services (Postgres, Redis) must be pinned with placement constraints and local volumes. Swarm does **not** solve distributed storage, and pretending otherwise is how people lose data. In a multi-node future, a database lives on exactly one node, explicitly.

### Compose services

Docker Compose files deploy via `docker stack deploy -c compose.yml`, which is Swarm-native and keeps one code path for both single services and multi-container apps. Note the gaps: `build:`, `depends_on` conditions, and a few other Compose keys are ignored in stack mode. Build first, then deploy the resulting image — which is already the flow in section 4.

### Server access: agentless

SSH only, no daemon to install or keep updated on target servers. Adding a server should mean pasting a host and a key, nothing else.

### Deploy targets: Docker only

No bare-metal or systemd deploy paths in v1. Every deployable artifact is a container.

---

## 10. Still Open

- **License.** This category has consolidated around open-core: a permissive or copyleft core, with RBAC, SSO, audit logs and white-labeling as a paid tier. Worth deciding early — relicensing after contributors arrive is painful.
- **Managed offering.** Whether Noddle ever has a hosted counterpart shapes how cleanly you separate control plane from target servers, so it's worth having an opinion before the deploy engine hardens.

