# CLAUDE.md — Noddle

Operating instructions for agents. Domain model and decisions are elsewhere:

| Doc | Role |
|---|---|
| `CONTEXT.md` | Glossary |
| `docs/adr/` | Settled decisions ([index](../docs/adr/README.md)) |
| `docs/agents/` | Skill wiring |
| `docs/README.md` | Doc map |

Read `CONTEXT.md` and relevant ADRs before exploring or proposing alternatives.
If an ADR looks wrong, say so once and stop — do not work around it.

---

## Agent skills

### Issue tracker

Issues and specs: `.scratch/<feature>/` (gitignored). See `docs/agents/issue-tracker.md`.

### Triage labels

`needs-triage` · `needs-info` · `ready-for-agent` · `ready-for-human` · `wontfix`
as `Status:` lines. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/`. This file is operating instructions
only. See `docs/agents/domain.md`.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | TanStack Start (Router, Query, Table, Form) |
| Validation | Zod, schemas shared client/server |
| ORM | Drizzle + Postgres |
| Auth | better-auth |
| Job queue | BullMQ + Redis |
| Remote exec | `ssh2` over SSH, `dockerode` tunneled through SSH |
| Builds | Nixpacks (shelled out), or Dockerfile if present |
| Realtime | SSE via a Start server function stream |
| Package manager | Bun (workspaces) — everywhere |
| Runtime | Bun, except `apps/worker` on Node (ADR-0015) |

Practical consequence of ADR-0014: **every new file is AGPL.** No incompatible
licenses.

---

## Repo layout

```
/apps
  /web                 TanStack Start (UI + server functions)
  /worker              BullMQ worker — build and deploy jobs
/packages
  /backup              Backup orchestration
  /backup-store        S3-compatible backup storage
  /build-engine        Nixpacks / image build
  /db                  Drizzle schema + migrations
  /deploy-contract     Shared deploy job contract
  /notifier            Notification channels
  /proxy-config        Traefik label generation
  /shared              Zod schemas, crypto, shared types
  /ssh-executor        SSH pool, remote Docker wrappers
  /tsconfig            Shared TypeScript config
/installer
  install.sh
  docker-compose.yml
/docs
  /adr                 Architecture decisions
  /agents              Skill wiring
/CONTEXT.md
```

`web` and `worker` are separate processes. Never run a build inside a server
function.

---

## Local development topology

Canonical: **ADR-0016**. Targets are **Multipass VMs** over real SSH — not DinD,
not OrbStack.

- **2 GB RAM on purpose** — reproduces build-cap OOM; do not raise it to pass a build
- Real SSH key access — never `multipass exec`
- Hostnames via `sslip.io`
- Multi-server = more VMs, not mocks
- TLS/ACME needs a public domain or Pebble; local Traefik serves HTTP. Proven on
  a public VPS (`noddle.ouestlabs.xyz`, 2026-08-03)

---

## Current phase

Phases 0–4 core are **done** (deploy loop, multi-server, backups, notifications,
resources, RBAC, registry builds, previews, audit log).

Still open:

- **CLI**
- **Teams / multi-tenancy** (distinct from RBAC)

Phase 0 spike CI (`.github/workflows/spike.yml`) must stay green — do not let a
red spike sit. Local Multipass remains the 2 GB pre-ship gate.

Do not reopen finished phase work without an ADR conflict flagged explicitly.

Spike reference (still the contract for the deploy chain):

| Run | Proves |
|---|---|
| `./scripts/spike-local.sh` | SSH → Swarm → clone → Nixpacks → service → Traefik → HTTP |
| `./scripts/spike-local.sh` (again) | `docker service update` zero-downtime path |
| `./scripts/spike-local.sh break` | broken image does not take down the running version |
| `./scripts/spike-local.sh cap` | memory-hungry build killed; running service untouched |

---

## Hard rules

**Bun is the package manager everywhere. `apps/worker` runs on NODE — ADR-0015,
settled by measurement, not preference.** `packages/ssh-executor/src/verify.ts`
runs the real paths against a real VM; run it on both runtimes to re-check after
any upgrade:

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

**The worker loads its code once, at startup.** It is a separate process from
`web`, so a change to `build-engine`, `ssh-executor` or `deploy.ts` does nothing
until it is restarted — the dashboard rebuild does not carry it. Three separate
symptoms in one session traced back to this, each looking like the fix had failed
rather than never having run. `bun run --cwd apps/worker dev` uses
`node --watch`, which does reload.

**Infrastructure code is not done when it typechecks.** Anything touching SSH,
Swarm, Nixpacks or Traefik must be run against a real VPS before it is considered
working. If you cannot test it, say so plainly instead of implying it works.

**Verify scripts (`verify*.ts`) are the project's real risk net.** Discover them
next to the module they cover. Do not delete a verify without a replacement for
the same invariant.

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

**`--env` is the exception, and it is the ONLY way to set a nixpacks config
variable.** The process environment is ignored, and the un-prefixed name is not
read. Measured on 1.41.0 against a real repository:

| invocation | plan |
|---|---|
| `NIXPACKS_NODE_VERSION=22 nixpacks build …` | `nodejs_18` — ignored |
| `nixpacks build … --env NODE_VERSION=22` | `nodejs_18` — wrong name |
| `nixpacks build … --env NIXPACKS_NODE_VERSION=22` | `nodejs_22` |

`--env` leaves the `overlays` list intact — checked, because that is exactly how
`--apt` fails and losing it is silent.

**Nixpacks defaults to Node 18, which nixpkgs has REMOVED as end-of-life.** So a
repository that declares no version does not build at all, and dies inside a nix
evaluation naming neither the project nor the setting. Upgrading nixpacks does
not help: the default is still 18 on `main`. Noddle supplies
`FALLBACK_NODE_VERSION` **only when the clone is silent** — the variable outranks
`engines.node`, `.nvmrc` and `.node-version`, so setting it always would override
the very thing a user chose deliberately.

**The versions Noddle installs are PINNED** (`packages/shared/src/toolchain.ts`,
mirrored in `installer/install.sh`, kept in step by `verify-toolchain`). Noddle
installs nixpacks itself, so it owns both halves of the compatibility pair — the
same reasoning as the Traefik pin below. Unpinned, two servers added a month
apart build differently with nothing in the diff to explain it. Note `sudo -E`:
without it the exported version is dropped and the install silently takes the
latest, which looks like a correct command.

**Swarm gotchas that will silently break things:**
- `HEALTHCHECK` needs a binary **inside** the image, and it runs under a **non-login `sh -c`**. Measured in `nixpacks:ubuntu-1745885067`: `curl` is present at `/bin/curl` and on `PATH`; `wget` is absent; `node` is **not** on `PATH` because it lives in the nix profile that only a *login* shell sources. So the healthcheck uses `curl`, and a `node -e` healthcheck would fail just as silently as `wget`. Either way it presents as a Traefik routing bug.
- `docker service create/update --no-resolve-image` for locally-built images. Without it Swarm tries to resolve the digest against a registry, fails, warns, then falls back to the tag — slow and noisy on one node.
- **Local builds pin a service to the node that built it.** The image exists nowhere else, so Swarm's scheduler cannot move it. **No longer true since Phase 4 for SERVICES**: the image is pushed to the embedded registry and placement is free — but the constraint remains, conditionally, for any image that was never pushed (rollback to a pre-registry version), and for Compose stacks and databases, which carry volumes. See `placementFor` in `deploy.ts`.
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
- **Monochrome for STATES, tinted for CATEGORIES.** The rule said "1 accent color plus neutrals"; the accent was never placed, and the question was settled on 2026-08-04: keep grey. **Amended on 2026-08-07, at the user's explicit request** — the preset's `--chart-1..5` tokens were at **chroma 0**, five identical greys in light and dark, and a categorical palette that does not distinguish its categories is useless: four parts of a stacked bar read as one, with the legend becoming the only way to read the chart. They now carry a hue, computed like `--success` (darker in light mode, lighter in dark, constant lightness across a series so no part disappears), spaced in HUE rather than lightness.
  **The boundary, and it is the one to hold:** a state — "it is running", "it is broken", a badge, a status — stays monochrome or `destructive`/`success`, because two states are never side by side and are read by the word. A CATEGORY within the same total (bar parts, graph series) takes a tint, because they touch and nothing else separates them. Do not extend colour beyond that case, and do not reset the palette to grey "to respect monochrome": that would undo a correction asked for after measuring on screen.
- **Visible text is in ENGLISH**, URLs included. **Amended on 2026-08-10** — code comments are English too, the project being open source: a contributor should not need French to understand a module's "why". Same for this file.
- One project dashboard: every service's status visible at a glance. DETAIL (logs, history, variables, resources, webhook) lives on its own page; it is the dashboard that must hide nothing, not the detail that must fit inside it — see the 2026-08-04 pass.
- Deploy is one button, always visible — never nested in a dropdown
- Env vars are an inline-editable table with a visible diff before save, not a raw textarea
- Logs live-tail by default, errors highlighted, build noise collapsed into expandable groups
- Advanced Docker/Traefik knobs are **not** exposed as UI fields. One raw config override textarea per service is the escape hatch.
- **Nothing that already exists in the preset is rewritten by hand.** A native `<select>` dressed with a class, a breadcrumb in `<nav>`, a link styled as a button: every time the result diverged from the rest (height, radius, dark mode, focus ring). `bunx shadcn add <component>` first, compose afterwards.

- **`Progress` is SINGLE-valued, and a STACKED bar is still composed from it** (`server-disk.tsx`, 2026-08-07). Its root carries one `value` and the preset wrapper attaches exactly one track/indicator pair: four parts of the same total therefore need one root PER part, wide by its own share and filled to 100% — WIDTH carries the information, never the value. The track loses its background and radius (they belong to the container of the four), and the indicator loses its transition, otherwise the bar fills on every render.
  **Two traps not to pay again:**
  - **`locale` defaults to the RUNTIME's, and there are two.** The Bun server renders `aria-valuetext` as "100 %" (non-breaking space), the browser as "100%". React does not see a typography difference but a disagreement between the two renders, and **rejects the entire tree to rebuild it** — a click that landed during that window sinks with no handler. Same class of bug as Phase 3's `relativeTime()`, this time from formatting a NUMBER. Set `locale="en-US"` explicitly, as for every preset component that formats a number or a date. Not centralised: `ui/progress.tsx` is rewritten by `shadcn add`, so it is the call site's job — redo at the second consumer, wrap the day there are three.
  - **Playwright's accessibility snapshot does NOT prune `aria-hidden` subtrees.** The four `role="progressbar"` keep appearing even though the attribute is correctly set on the container AND on each root — verified in the DOM. False positive of the same family as the shadscan ones already noted: measurement decides, never the tool's output.
- **BRAND LOGOS are allowed, and only for database engines**
  (2026-08-09). The colour rule above already permitted them — five engines side
  by side are CATEGORIES, not states — but the component rejected them on the
  grounds that a brand redrawn from memory is wrong. They live in
  `database-icons.tsx`, exposed only through `DatabaseMark`. They keep THEIR
  colours: a brand stripped of its colour stops being recognisable, which would
  cancel the reason to show it.
  **That exception is that one and not an open door** — nothing else in the
  product takes a third-party logo.
  Measured corollary: a brand with a near-black single fill (MariaDB,
  `#231F20`) DISAPPEARS in dark theme. It switches to `currentColor` and follows
  `--foreground`. Check every brand on BOTH backgrounds before placing it.

- **Label/field spacing belongs to `Field`**, not the caller. Fifteen fields used
  a bare `<div>` and ended up without the component's `gap-3` — label stuck to
  its input, differently per screen.

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
here. Domain decisions live in `CONTEXT.md` and `docs/adr/`, not in this file.
