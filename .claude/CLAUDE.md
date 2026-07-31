# CLAUDE.md — Noddle

Read this at the start of every session. It is the source of truth for what Noddle is and what has already been decided.

---

## What Noddle is

A self-hosted deployment platform. You point it at a git repo, it builds and runs the app on a VPS you own, with HTTPS and a domain, from a dashboard.

Installed on any Linux VPS with one command. Manages one or many target servers.

**The differentiator is restraint, not features.** Comparable tools lose to feature creep and cluttered dashboards. Every screen must answer "is it healthy" and "how do I ship" without drilling into a submenu. When in doubt, cut.

---

## Settled decisions — do not relitigate

These are decided. Do not re-open them, do not silently work around them, do not propose alternatives in passing.

If you have strong evidence one is wrong, **say so once, explicitly, and stop for an answer.** Do not proceed on your own judgment.


| Decision        | Choice                                                 | Why                                                                                                                                                   |
| --------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestration   | **Docker Swarm mode**, single node to start            | `docker service update` is a transactional deploy primitive — rolling update, health gate and rollback are already correct, including edge cases      |
| Build location  | **On the target server**                               | "one command on any VPS" is a core requirement; building elsewhere needs an always-on machine or a registry hop                                       |
| Build isolation | **Every build resource-capped** (`--memory`, `--cpus`) | a Next.js build on a 2 GB VPS will OOM and take down running production apps                                                                          |
| Server access   | **Agentless, SSH only**                                | adding a server = paste a host and a key, nothing else                                                                                                |
| Deploy targets  | **Docker only**                                        | no bare-metal or systemd paths                                                                                                                        |
| Reverse proxy   | **Traefik**, Swarm provider                            | dynamic label-based routing, native Let's Encrypt                                                                                                     |
| RPC layer       | **TanStack Start** `createServerFn`, no tRPC           | Start already gives end-to-end type safety; two RPC layers is waste. tRPC only if a public API or CLI ever needs a versioned contract outside the app |


Still open, decide before contributors arrive: **license** (this category has consolidated around open-core — permissive core, RBAC/SSO/audit logs as paid tier).

---

## Stack


| Layer           | Choice                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| Framework       | TanStack Start (Router, Query, Table, Form)                                 |
| Validation      | Zod, schemas shared client/server                                           |
| ORM             | Drizzle + Postgres                                                          |
| Auth            | better-auth                                                                 |
| Job queue       | BullMQ + Redis                                                              |
| Remote exec     | `ssh2` over SSH, `dockerode` for the Docker Engine API tunneled through SSH |
| Builds          | Nixpacks (shelled out to), or Dockerfile if present                         |
| Realtime        | SSE via a Start server function stream                                      |
| Package manager | pnpm workspaces                                                             |


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

`web` and `worker` are separate processes from day one. Deploys take minutes — never run a build inside a server function.

---

## Local development topology

Development runs against **local Multipass VMs**, not a rented VPS. A VM is the closest free equivalent of a real server: real systemd, real network stack, real SSH, real Docker install path.

Do **not** substitute Docker-in-Docker for a VM. Swarm overlay networks create VXLAN interfaces even on a single node; DinD mostly works and fails in ways that do not exist in production.

- Target VMs are provisioned at **2 GB RAM on purpose** — the size of a cheap VPS, and the only way to actually reproduce the OOM scenario the build-capping decision exists to prevent. Do not raise it to make a build pass; that is the bug.
- Access is over **real SSH with a key**, never `multipass exec`. SSH is the production access path, so it is the one that must be exercised.
- Hostnames use `sslip.io` (`app.10-0-0-5.sslip.io` resolves to `10.0.0.5`), so Host-based routing is tested without editing `/etc/hosts`.
- Multi-server work in Phase 2 means launching a second and third VM, not mocking one.

**TLS cannot be fully tested locally.** ACME requires a publicly reachable domain. In dev, Traefik serves plain HTTP. To exercise the ACME code path without real certificates, point `--certificatesresolvers.le.acme.caserver` at **Pebble** (Let's Encrypt's test server). Real certificate issuance needs exactly one run against a real VPS with real DNS before shipping — budget for it, do not skip it.

---

## Current phase

**Phase 0 — validate the deploy chain end to end.**

`spike-local.sh` must produce a working URL on a local VM before any application code gets written. Nothing else matters until it does.

Run it twice: the second pass takes the `docker service update` path, which is where zero-downtime behaviour is actually observable.

Then, in order:

1. **Phase 1** — Drizzle schema + BullMQ, spike logic ported into a worker job. Auth, add one server, connect a repo, deploy, live log stream, start/stop/restart.
2. **Phase 2** — multi-server, Docker Compose deploys via `docker stack deploy`, env var UI, webhook deploys, one-click database services.
3. **Phase 3** — backups to S3-compatible storage, notifications, resource graphs, teams/RBAC, rollback.
4. **Phase 4** — registry-based builds, preview environments per PR, audit log, CLI.

**Do not build Phase 2 features while Phase 1 is unreliable.** The deploy loop's correctness is what the entire product's trust rests on.

---

## Hard rules

**Infrastructure code is not done when it typechecks.** Anything touching SSH, Swarm, Nixpacks or Traefik must be run against a real VPS before it is considered working. If you cannot test it, say so plainly instead of implying it works.

**Never hand-roll the deploy swap.** Use `docker service update --update-order start-first --update-failure-action rollback` with a `HEALTHCHECK` on the service. The whole point of running Swarm is that this behaviour is already correct.

**Swarm gotchas that will silently break things:**

- Traefik reads labels on the **service**, not the container
- `traefik.http.services.<name>.loadbalancer.server.port` is **required** — Traefik cannot infer the port in Swarm mode
- Traefik v3 uses `--providers.swarm`; v2 used `--providers.docker.swarmMode`. Check against the pinned version.
- `docker stack deploy` **ignores** `build:` and conditional `depends_on`. Build first, deploy the resulting image.
- Swarm does **not** solve distributed storage. Stateful services (Postgres, Redis) are pinned with placement constraints and local volumes. A database lives on exactly one node, explicitly.

**Secrets** — SSH keys, env var values, webhook URLs are encrypted at rest with AES-256-GCM from an app-level `APP_KEY`. Never log decrypted values. Prefer `docker secret` over env vars so nothing leaks into `docker inspect`.

**Deployment logs** — stream to SSE and persist to disk or object storage. Do not write one Postgres row per log line.

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

