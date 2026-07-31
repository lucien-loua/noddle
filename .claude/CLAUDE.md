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

Still open, decide before contributors arrive: **license** (this category has
consolidated around open-core — permissive core, RBAC/SSO/audit logs as paid tier).

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
| Runtime + package manager | Bun (workspaces via `package.json`) |

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

**TLS cannot be fully tested locally.** ACME requires a publicly reachable
domain. In dev, Traefik serves plain HTTP. To exercise the ACME code path
without real certificates, point
`--certificatesresolvers.le.acme.caserver` at **Pebble** (Let's Encrypt's test
server). Real certificate issuance needs exactly one run against a real VPS with
real DNS before shipping — budget for it, do not skip it.

---

## Current phase

**Phase 0 — validate the deploy chain end to end.**

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

1. **Phase 1** — Drizzle schema + BullMQ, spike logic ported into a worker job. Auth, installer adopts its own host as server #1, connect a repo, deploy, live log stream, start/stop/restart, one-click rollback (`docker service rollback` — free from the Swarm decision, so it ships with the deploy loop).
2. **Phase 2** — multi-server, Docker Compose deploys via `docker stack deploy`, env var UI, webhook deploys, one-click database services.
3. **Phase 3** — backups to S3-compatible storage, notifications, resource graphs, teams/RBAC.
4. **Phase 4** — registry-based builds, preview environments per PR, audit log, CLI.

**Do not build Phase 2 features while Phase 1 is unreliable.** The deploy loop's
correctness is what the entire product's trust rests on.

---

## Hard rules

**Bun is the package manager everywhere. Bun as the *runtime* for `apps/worker`
is unverified.** The worker depends on `ssh2` and `dockerode`; `ssh2` carries
optional native addons. Prove the SSH and Docker paths actually run on Bun before
building on top of them. If they don't, `apps/worker` runs on Node and everything
else stays Bun — that is a normal outcome, not a failure.

**Infrastructure code is not done when it typechecks.** Anything touching SSH,
Swarm, Nixpacks or Traefik must be run against a real VPS before it is considered
working. If you cannot test it, say so plainly instead of implying it works.

**Never hand-roll the deploy swap.** Use `docker service update --update-order
start-first --update-failure-action rollback` with a `HEALTHCHECK` on the service.
The whole point of running Swarm is that this behaviour is already correct.

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