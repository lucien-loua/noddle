# CLAUDE.md — Noddle

Operating instructions for agents. The domain model and the code standards are elsewhere:

| Doc          | Role           |
| ------------ | -------------- |
| `CONTEXT.md` | Glossary       |
| `AGENTS.md`  | Code standards |

Read `CONTEXT.md` before exploring or proposing alternatives. The settled decisions are the **Hard rules** below; if one looks wrong, say so once and stop — do not work around it.

---

## Agent skills

### Issue tracker

Issues and specs: `.scratch/<feature>/` (gitignored).

### Triage labels

`needs-triage` · `needs-info` · `ready-for-agent` · `ready-for-human` · `wontfix` as `Status:` lines.

### Domain docs

Single-context: `CONTEXT.md`. This file is operating instructions only.

---

## Stack

| Layer           | Choice                                                   |
| --------------- | -------------------------------------------------------- |
| Framework       | TanStack Start (Router, Query, Table, Form)              |
| Validation      | Zod, schemas shared client/server                        |
| ORM             | Drizzle + Postgres                                       |
| Auth            | better-auth                                              |
| Job queue       | BullMQ + Redis                                           |
| Remote exec     | `ssh2` over SSH, `dockerode` tunneled through SSH        |
| Builds          | Railpack → BuildKit, or Dockerfile via buildx if present |
| Realtime        | SSE via a Start server function stream                   |
| Package manager | Bun (workspaces) — everywhere                            |
| Runtime         | Bun, except `apps/worker` on Node                        |

Practical consequence of the Apache-2.0 licence: **every new file is Apache-2.0.** Permissive dependencies (MIT, BSD, ISC, Apache) are fine; **GPL and AGPL code cannot come in** — that is the direction now closed.

---

## Repo layout

```
/apps
  /web                      TanStack Start (UI + server functions)
  /worker                   BullMQ worker — build and deploy jobs
/packages
  /backup                   Backup orchestration + S3-compatible storage
  /crypto                   AES-256-GCM secrets, derived from APP_KEY
  /db                       Drizzle schema + migrations
  /deploy-contract          Shared deploy job contract
  /deploy-engine            Build, Traefik labels, Compose→Swarm, service ops
  /git-provider             GitHub App / GitLab OAuth API access
  /git-provider-credentials Forge token storage and refresh
  /shared                   Zod schemas, policies, engine specs, notification channels
  /ssh-credentials          Server access resolved from the SSH key library
  /ssh-executor             SSH pool, remote Docker wrappers
  /testing                  Verify harness + dev-stack helpers
  /tsconfig                 Shared TypeScript config
/installer
  install.sh
  docker-compose.yml
  docker-compose.tls.yml
/scripts                    spike-local.sh, adopt-local.sh, dev preflight
/CONTEXT.md
/AGENTS.md
```

`web` and `worker` are separate processes. Never run a build inside a server function.

---

## Local development topology

Targets are **Multipass VMs** over real SSH — not DinD, not OrbStack.

- **2 GB RAM on purpose** — reproduces build-cap OOM; do not raise it to pass a build
- Real SSH key access — never `multipass exec`
- Hostnames via `sslip.io`
- Multi-server = more VMs, not mocks
- TLS/ACME needs a public domain or Pebble; local Traefik serves HTTP. Proven on a public VPS (`noddle.ouestlabs.xyz`, 2026-08-03)

---

## Current phase

Phases 0–4 core are **done** (deploy loop, multi-server, backups, notifications, resources, RBAC, registry builds, previews, audit log).

Still open:

- **CLI**
- **Teams / multi-tenancy** (distinct from RBAC)

Phase 0 spike CI (`.github/workflows/spike.yml`) must stay green — do not let a red spike sit. Local Multipass remains the 2 GB pre-ship gate.

Do not reopen finished phase work without an ADR conflict flagged explicitly.

Spike reference (still the contract for the deploy chain):

| Run | Proves |
| --- | --- |
| `./scripts/spike-local.sh` | SSH → Swarm → clone → Railpack → service → Traefik → HTTP |
| `./scripts/spike-local.sh` (again) | `docker service update` zero-downtime path |
| `./scripts/spike-local.sh break` | broken image does not take down the running version |
| `./scripts/spike-local.sh cap` | memory-hungry build killed; running service untouched |

---

## Hard rules

**Bun is the package manager everywhere. `apps/worker` runs on NODE — settled by measurement, not preference.** `packages/ssh-executor/src/verify.ts` runs the real paths against a real VM; run it on both runtimes to re-check after any upgrade:

|  | `ssh2` | `dockerode` over the SSH tunnel |  |
| --- | --- | --- | --- |
| Node 24 | ✓ | ✓ Docker 29.7.1, `UpdateStatus.State` readable | **9/9** |
| Bun 1.3.13 | ✓ | ✗ `ECONNREFUSED` | 6/7 |

`ssh2` itself is fine on Bun — connection, exec, exit codes, chunked streaming. What breaks is `dockerode` over the tunnel. **Two independent approaches were tried and both fail on Bun:**

| approach | Node | Bun |
| --- | --- | --- |
| custom `createConnection` on `http.Agent` | ✓ | ✗ `ECONNREFUSED` — Bun ignores it and opens a real TCP connection to the placeholder host |
| local Unix socket proxied to the remote socket over an SSH channel (no agent at all) | ✓ | ✗ hangs forever on the first request |

The second was the obvious escape hatch — no custom agent, so nothing for a runtime to ignore — and it still hangs. Only the `http.Agent` path is kept in the code; the socket-proxy variant was deleted rather than left as dead code.

So: Bun for install/workspaces/scripts, Node for the worker process. Do not "simplify" this back to one runtime without re-running the verifier.

Scope of the constraint: **only `dockerode` is affected.** `postgres.js` and Drizzle were smoke-tested on both runtimes against a real Postgres 17 — inserts, relational queries and enums all work identically. So `packages/db` is runtime agnostic; do not assume the Node requirement spreads.

Two constraints that follow, both already cost time:

- **No TypeScript parameter properties** (`constructor(private readonly x: T)`) in code the worker loads. Node's strip-only type stripping refuses them — it removes types, it does not transform. Oxlint flags them too.
- **An ssh2 `Channel` is a `Duplex`, not a `net.Socket`.** Node's HTTP agent calls `setKeepAlive`/`setNoDelay`/`ref` on whatever `createConnection` returns, and the failure surfaces as an unreadable `TypeError` from inside `node:_http_agent`. The executor stubs the missing methods and disables agent keep-alive.

**The worker loads its code once, at startup.** It is a separate process from `web`, so a change to `build-engine`, `ssh-executor` or `deploy.ts` does nothing until it is restarted — the dashboard rebuild does not carry it. Three separate symptoms in one session traced back to this, each looking like the fix had failed rather than never having run. `bun run --cwd apps/worker dev` uses `node --watch`, which does reload.

**Infrastructure code is not done when it typechecks.** Anything touching SSH, Swarm, Railpack or Traefik must be run against a real VPS before it is considered working. If you cannot test it, say so plainly instead of implying it works.

**Verify scripts (`verify*.ts`) are the project's real risk net.** Discover them next to the module they cover. Do not delete a verify without a replacement for the same invariant.

**Never hand-roll the deploy swap.** Use `docker service update --update-order start-first --update-failure-action rollback` with a `HEALTHCHECK` on the service. The whole point of running Swarm is that this behaviour is already correct. Verified on a real VM: a broken image fails its healthcheck, Swarm rolls back on its own, and the previous version keeps serving without interruption.

**Swarm's safety net expires. `--update-monitor` is not a tuning knob — it is the definition of "when is a deploy considered final".** Measured on a real VM, same image, only the crash delay changed:

| App dies at | vs `monitor=45s` | Outcome |
| --- | --- | --- |
| 25 s | inside | Swarm counts the failure and **rolls back**. Previous version serves again. |
| 90 s | outside | Update reported `completed`. Previous task already drained. Restart policy relaunches **the broken image**, forever. Measured availability: **9/12 requests over 60 s**, indefinitely. |

Raising the window is not the fix: it makes every deploy wait that long before it is confirmed, and a crash one minute later still slips through. Real apps die under load after minutes, not seconds — so the outside case is the _common_ one.

**Therefore the worker keeps watching after the deploy "succeeds."** Swarm's monitor stays short so deploys stay fast; Noddle observes the service for a few minutes afterwards, and if the task restarts repeatedly it marks the deployment failed and redeploys the previous image **from its own database**. This is something Swarm structurally cannot do: Noddle has the whole deployment history, Swarm retains one previous spec. Ship it with the deploy loop in Phase 1 — the one-click rollback already scheduled there is the same machinery.

**A failed deploy exits 0.** `docker service update --update-failure-action rollback` returns 0 after a _successful rollback_ — the deploy failed, the command succeeded. Measured. So the worker must never infer deploy success from the exit code; read `docker service inspect --format '{{.UpdateStatus.State}}'` and treat `rollback_completed` / `rollback_paused` as failure. Getting this wrong means the dashboard reports a green deploy while the old version is what's actually serving.

**Never `cmd | grep -q` in remote scripts.** They run under `set -o pipefail`. `grep -q` exits at the first match, the producer takes SIGPIPE (141), and pipefail turns that into a failed pipeline. It is a _race_ — whether the producer finished writing first — so the same code passes and fails on alternate runs. This cost a Phase 0 run: `docker info | grep -q 'Swarm: active'` intermittently re-ran `swarm init` on an already-swarmed node. Query state directly instead: `docker info --format '{{.Swarm.LocalNodeState}}'`. Same trap with `| head`.

**Capping a build: cap the DAEMON, not the build command.**

`docker build --memory` / `--cpus` **does not work.** BuildKit accepts the flags and ignores them ([moby/buildkit#1362](https://github.com/moby/buildkit/issues/1362); [docker/buildx#644](https://github.com/docker/buildx/issues/644) proposes deleting them outright). A cap written that way is a silent no-op — the worst failure shape, because the build succeeds and the protection looks like it works.

Railpack does not emit a Dockerfile at all: it builds the LLB graph and hands it to BuildKit over `BUILDKIT_HOST`. So **Noddle starts `buildkitd` itself** and both build paths attach to that one container (`ensureCappedBuilder`):

1. `docker run -d --privileged --memory=… --cpu-quota=… --cpu-period=… moby/buildkit`
2. railpack → `sudo -E env BUILDKIT_HOST=docker-container://noddle-buildkit railpack build DIR --name TAG --progress plain`
3. a user's Dockerfile → `docker buildx create --driver remote docker-container://noddle-buildkit`, then the usual `buildx build --load`

**One daemon on purpose.** Two separately capped daemons would each get the full cap, so a Compose build beside an app build takes twice what the machine has. And `ensureCappedBuilder` checks the builder's **DRIVER**, not just that it exists: a server from before railpack has `noddle-builder` on `docker-container` with its own daemon, and it must be removed and recreated. `--progress plain` is required either way — the TTY renderer rewrites the screen and is unusable as an SSE stream.

**`sudo -E` is load-bearing, for TWO reasons at once.** Railpack reads `BUILDKIT_HOST` from its environment and exits if it is unset, and plain `sudo` drops it. And the image only reaches the daemon because railpack pipes BuildKit's `ExporterDocker` tarball into a bare **`docker load`** — the binary name is hardcoded in railpack, with no sudo and no override — so the invoking user has to reach the docker socket already. `--output` is NOT that path: it exports a filesystem, not an image. There is also **no registry-push exporter**; the embedded registry keeps its own `docker push` step.

**Railpack config variables go through `--env`, and only `--env`.** The process environment is not read for them. Same shape as the old nixpacks rule, new prefix: `RAILPACK_DEPLOY_APT_PACKAGES`, `RAILPACK_SPA_OUTPUT_DIR` (note `OUTPUT`, where nixpacks said `OUT`). Setting the SPA dir _forces_ static mode even when framework detection would not have fired.

**Package injection WORKS now, and Noddle depends on it.** This is the rule that inverted. Nixpacks' `--apt`/`--pkgs` wiped the nix `overlays` list and broke every Node build, so nothing could be added to an image. Railpack has no overlay to lose: `RAILPACK_BUILD_APT_PACKAGES` / `RAILPACK_DEPLOY_APT_PACKAGES` work, and a leading `...` **extends** railpack's generated list — omit it and the list is REPLACED, silently. Guarded by `verify-build-dir`.

**The base image inverted too, and this one fails silently.** Measured inside a built image under the same non-login `sh -c` a HEALTHCHECK runs in:

|  | `nixpacks:ubuntu` | railpack (Debian 12) |
| --- | --- | --- |
| `curl` | present, `/bin/curl` | **ABSENT** |
| `wget` | absent | absent |
| `node` | **not** on PATH (login-shell nix profile) | present, `/mise/shims/node` |

The deploy healthcheck is a curl probe, so `build-engine` forces `curl` into every image Noddle builds from source (`FORCED_DEPLOY_PACKAGES`). Drop that and no task ever converges — and it presents as a Traefik routing bug, not a missing binary. For a user's own Dockerfile it stays their image's problem, as before.

**Railpack resolves Node 24 for a repository that declares nothing** — the Node-18-is-EOL failure has no analogue, and `FALLBACK_NODE_VERSION` was deleted with it. Explicit `engines.node` / `.nvmrc` / `.node-version` still win.

**The versions Noddle installs are PINNED** (`packages/shared/src/toolchain.ts`, mirrored in `installer/install.sh`, kept in step by `verify-toolchain`). That now covers `RAILPACK_VERSION` **and `BUILDKIT_IMAGE`** — Noddle starts the daemon itself, so it owns that half of the pair too, same reasoning as the Traefik pin below. Unpinned, two servers added a month apart build differently with nothing in the diff to explain it. Note `sudo -E` again: without it the exported version is dropped and the install silently takes the latest, which looks like a correct command.

**Swarm gotchas that will silently break things:**

- `HEALTHCHECK` needs a binary **inside** the image, and it runs under a **non-login `sh -c`** — see the base-image table above. Noddle forces `curl` in on the railpack path; for any other image the binary has to already be there, and its absence presents as a Traefik routing bug.
- `docker service create/update --no-resolve-image` for locally-built images. Without it Swarm tries to resolve the digest against a registry, fails, warns, then falls back to the tag — slow and noisy on one node.
- **Local builds pin a service to the node that built it.** The image exists nowhere else, so Swarm's scheduler cannot move it. **No longer true since Phase 4 for SERVICES**: the image is pushed to the embedded registry and placement is free — but the constraint remains, conditionally, for any image that was never pushed (rollback to a pre-registry version), and for Compose stacks and databases, which carry volumes. See `placementFor` in `deploy.ts`.
- Traefik reads labels on the **service**, not the container
- `traefik.http.services.<name>.loadbalancer.server.port` is **required** — Traefik cannot infer the port in Swarm mode
- Traefik v3 uses `--providers.swarm`; v2 used `--providers.docker.swarmMode`. Check against the pinned version.
- **Traefik must be pinned to >= 3.6.** Below that its embedded Docker SDK is fixed at API 1.24, which Docker Engine 29 rejects (minimum 1.40). The Swarm provider then never connects, discovers nothing, and every request 404s — while the service, its labels and the overlay network are all correct, and Traefik itself answers on :80. The most misleading failure in the chain: nothing looks broken, and the only evidence is one retrying line in Traefik's own log. Fixed upstream in milestone 3.6 ([traefik#12253](https://github.com/traefik/traefik/issues/12253)); the spike pins an exact patch. **The widely-repeated `DOCKER_API_VERSION` workaround does not work.** Measured on v3.3: the variable is present in the container's environment, the container restarts, and Traefik still announces 1.24. Do not reach for it — upgrade the version. Noddle installs Docker _itself_, so it owns both halves of this compatibility pair. Let either float independently and fresh installs break.
- `docker stack deploy` **ignores** `build:` and conditional `depends_on`. Build first, deploy the resulting image.
- Swarm does **not** solve distributed storage. Stateful services (Postgres, Redis) are pinned with placement constraints and local volumes. A database lives on exactly one node, explicitly.

**Applying a migration is not undone by `git checkout`.** The FILE goes, the `ALTER TABLE` stays. Generate the SQL and read it, but do NOT run `migrate` while an approach is still exploratory — and if one was applied and the approach is then dropped, undo it in the DATABASE in the same breath as deleting the file. Measured on 2026-08-21: an abandoned `services.swarm_name NOT NULL` survived the file being removed, so every service INSERT failed and creating an application was broken, while every migration file looked correct. The serverFn boundary reported `Cannot read properties of undefined (reading 'PROD')` instead of the SQL error, and stashing the code to "test HEAD" proved nothing — a stash does not restore the database. `verify-schema-drift` now fails on exactly this: a NOT NULL column no migration names.

**A resource has TWO names and they never swap.** `name` is the IDENTITY — `swarmServiceName()` derives the running Swarm service from it, volumes are named after it, the unique index covers `(environmentId, name)`, and the typed delete confirmation is checked against it server-side. `display_name` is cosmetic and nullable; nothing derives from it. In any row or props type, keep `name` meaning the identity and add a separate `label` for what the screen shows, resolved once with `displayNameOf()` at the boundary. Pointing `name` at the display name compiles and renders fine, then silently makes every renamed resource UNDELETABLE — the dialog asks for the displayed name while the server compares the identity. It broke three delete paths at once before anyone noticed.

**Secrets** — SSH keys, env var values, webhook URLs are encrypted at rest with AES-256-GCM from an app-level `APP_KEY`. Never log decrypted values. Prefer `docker secret` over env vars so nothing leaks into `docker inspect`.

**Deployment logs** — stream to SSE and persist to disk or object storage. Do not write one Postgres row per log line.

**No comments. The reasoning goes in the commit message.** Settled on 2026-08-31: the TypeScript surface lost 5 646 comments (11 250 lines), the shell / YAML / Dockerfile surface 513 more. A comment drifts from the code it describes and nothing checks it; `git log -S` finds the why.

**What survived is NOT prose. Every marker below is read by a machine, and deleting it breaks something silently:**

| marker | read by | if removed |
| --- | --- | --- |
| `// tier: local\|pure\|vm\|fixture` | `packages/testing/src/run-tier.ts` | the bench is no longer routed — and it MUST be line 1 |
| `// runtime: bun\|node` | same | the bench runs on the wrong runtime |
| `// oxlint-disable-next-line …` | oxlint | the rule fires again |
| `// @ts-nocheck`, `/// <reference …>` | tsc | typecheck breaks |
| `--> statement-breakpoint` | drizzle's `migrator.js` | the whole migration collapses into ONE statement |
| `#!/usr/bin/env …` | the kernel | the script stops being executable |
| any `#` inside a heredoc | nothing — it is DATA | `#cloud-config` is cloud-init's magic first line |

**Strip with a PARSER, never a regex.** `oxc-parser` for TS (the one oxlint itself uses), `mvdan-sh` for shell, `yaml`'s CST for YAML. Measured on that pass: a `//` inside a string, a regex or JSX text, and a `#` inside `${#arr[@]}`, a quoted string or a heredoc — a regex eats all of them. And Go hands back BYTE offsets: `install.sh` is 14 895 bytes for 14 041 characters (`▸`, `✗`, `──`), so a JS string index drifts from the first glyph on and corrupts everything after it. Validate the result against a canonical form — `mvdan-sh` printing with `Minify(true)` ignores blank lines and comments, so only a real change shows.

**Two lint rules carry options because of this** (`oxlint.config.ts`): `no-empty` with `allowEmptyCatch`, `no-empty-function` with `allow: ["arrowFunctions"]`. Their help text says "add a comment inside it", which is unsatisfiable here — 54 errors, all of them `try { … } catch {}` or `.catch(() => {})`.

**A verify that greps for a comment is a verify that breaks.** `verify-backup-policy` anchored an invariant on the string "Object may already be gone". Re-anchored on `deleteObject(`: a call cannot be reworded away.

---

## UI rules

The design system is deliberately constrained. Treat these as limits, not defaults:

- ~4 type sizes, 2 elevation levels max
- **Monochrome for STATES, tinted for CATEGORIES.** The rule said "1 accent color plus neutrals"; the accent was never placed, and the question was settled on 2026-08-04: keep grey. **Amended on 2026-08-07, at the user's explicit request** — the preset's `--chart-1..5` tokens were at **chroma 0**, five identical greys in light and dark, and a categorical palette that does not distinguish its categories is useless: four parts of a stacked bar read as one, with the legend becoming the only way to read the chart. They now carry a hue, computed like `--success` (darker in light mode, lighter in dark, constant lightness across a series so no part disappears), spaced in HUE rather than lightness. **The boundary, and it is the one to hold:** a state — "it is running", "it is broken", a badge, a status — stays monochrome or `destructive`/`success`, because two states are never side by side and are read by the word. A CATEGORY within the same total (bar parts, graph series) takes a tint, because they touch and nothing else separates them. Do not extend colour beyond that case, and do not reset the palette to grey "to respect monochrome": that would undo a correction asked for after measuring on screen.
- **Visible text is in ENGLISH**, URLs included. The 2026-08-10 amendment extended this to code comments; **it lapsed on 2026-08-31**, when the comments went — see the no-comments rule above. This file and the docs stay English, the project being open source.
- One project dashboard: every service's status visible at a glance. DETAIL (logs, history, variables, resources, webhook) lives on its own page; it is the dashboard that must hide nothing, not the detail that must fit inside it — see the 2026-08-04 pass.
- Deploy is one button, always visible — never nested in a dropdown
- Env vars are an inline-editable table with a visible diff before save, not a raw textarea
- Logs live-tail by default, errors highlighted, build noise collapsed into expandable groups
- Advanced Docker/Traefik knobs are **not** exposed as UI fields. One raw config override textarea per service is the escape hatch.
- **Nothing that already exists in the preset is rewritten by hand.** A native `<select>` dressed with a class, a breadcrumb in `<nav>`, a link styled as a button: every time the result diverged from the rest (height, radius, dark mode, focus ring). `bunx shadcn add <component>` first, compose afterwards.

- **`Progress` is SINGLE-valued, and a STACKED bar is still composed from it** (`server-disk.tsx`, 2026-08-07). Its root carries one `value` and the preset wrapper attaches exactly one track/indicator pair: four parts of the same total therefore need one root PER part, wide by its own share and filled to 100% — WIDTH carries the information, never the value. The track loses its background and radius (they belong to the container of the four), and the indicator loses its transition, otherwise the bar fills on every render. **Two traps not to pay again:**
  - **`locale` defaults to the RUNTIME's, and there are two.** The Bun server renders `aria-valuetext` as "100 %" (non-breaking space), the browser as "100%". React does not see a typography difference but a disagreement between the two renders, and **rejects the entire tree to rebuild it** — a click that landed during that window sinks with no handler. Same class of bug as Phase 3's `relativeTime()`, this time from formatting a NUMBER. Set `locale="en-US"` explicitly, as for every preset component that formats a number or a date. Not centralised: `ui/progress.tsx` is rewritten by `shadcn add`, so it is the call site's job — redo at the second consumer, wrap the day there are three.
  - **Playwright's accessibility snapshot does NOT prune `aria-hidden` subtrees.** The four `role="progressbar"` keep appearing even though the attribute is correctly set on the container AND on each root — verified in the DOM. False positive of the same family as the shadscan ones already noted: measurement decides, never the tool's output.
- **BRAND LOGOS are allowed on a NAMED LIST and nowhere else** (2026-08-09, extended 2026-08-20). The list was database engines alone at first. The colour rule above already permitted them — five engines side by side are CATEGORIES, not states — but the component rejected them on the grounds that a brand redrawn from memory is wrong. They live in `database-icons.tsx`, exposed only through `DatabaseMark`. They keep THEIR colours: a brand stripped of its colour stops being recognisable, which would cancel the reason to show it. **Amended on 2026-08-20, at the user's explicit request:** the second logo is Traefik, on the topology's boundary node (`traefik-mark.tsx`, used only in the `Proxy` row). The reasoning is the same one that admitted the engines — the node reports a PRODUCT, not a state, and the word alone does not say which proxy is doing the routing. **The list is still a LIST, not a door**: database engines and Traefik, nothing else takes a third-party logo without the same argument being made again. Both rules below still bind — lift the asset, never redraw it (the mark came from Traefik's own SVG, its wordmark half dropped as illegible at 16px, the viewBox squared around the MEASURED bbox), and check it on both themes (`#24A1C1` holds on each, so it keeps its colour). Measured corollary: a brand with a near-black single fill (MariaDB, `#231F20`) DISAPPEARS in dark theme. It switches to `currentColor` and follows `--foreground`. Check every brand on BOTH backgrounds before placing it.

- **Label/field spacing belongs to `Field`**, not the caller. Fifteen fields used a bare `<div>` and ended up without the component's `gap-3` — label stuck to its input, differently per screen.

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

Enforced mechanically by **oxlint** (rules) and **oxfmt** (formatting), both driven by Ultracite — `bun run check` / `bun run fix`.

Task orchestration is Vite+ (`vp run -r <task>`), which is a separate concern: it schedules the per-package scripts and does NOT read `oxlint.config.ts`. Measured — turning a rule back on there produced nothing under `vp lint`. Lint config belongs to Ultracite, task config to Vite+. The prose reference lives in `AGENTS.md` at the repo root; it is not repeated here. Domain decisions live in `CONTEXT.md`, not in this file.

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun x ultracite check`
- **Diagnose setup**: `bun x ultracite doctor`

Oxlint + Oxfmt (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**

- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**

- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Oxlint + Oxfmt Can't Help

Oxlint + Oxfmt's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Oxlint + Oxfmt can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - No comments: make the code self-documenting and put the why in the commit message

---

Most formatting and common issues are automatically fixed by Oxlint + Oxfmt. Run `bun x ultracite fix` before committing to ensure compliance.
