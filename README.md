# Noddle

Self-hosted deployment platform: point it at a git repository, it builds and runs the app on a VPS you own, with HTTPS and a domain, from a dashboard.

Restraint over feature count — every screen answers "is it healthy" and "how do I ship". The vocabulary the code uses is defined in [CONTEXT.md](./CONTEXT.md).

## Running it locally

```bash
bun install
bun run dev
```

`dev` checks its prerequisites, seeds `apps/*/.env` from the committed examples, brings up Postgres, Redis and S3 in Docker, applies migrations, then starts the dashboard and the worker together.

The dashboard answers on <http://127.0.0.1:3000>.

|                           |                                      |
| ------------------------- | ------------------------------------ |
| `bun run dev`             | the whole thing                      |
| `bun run dev:stack`       | Postgres, Redis, RustFS on their own |
| `bun run dev:stack:reset` | drop the volumes, recreate, migrate  |

**Deploying something needs a target server**, which local development gets from a Multipass VM over real SSH — not Docker-in-Docker, and deliberately at 2 GB so build-cap OOMs are reproducible ([ADR-0016](./docs/adr/0016-local-multipass-topology.md)):

```bash
./scripts/spike-local.sh     # provision the VM and run the deploy chain on it
./scripts/adopt-local.sh     # register it as target server #1
```

## Two processes, two runtimes

`apps/web` runs on Bun, `apps/worker` on **Node** — settled by measurement, not preference: `dockerode` over an SSH tunnel does not work on Bun ([ADR-0015](./docs/adr/0015-worker-runs-on-node.md)). Bun is the package manager everywhere.

The worker loads its code once, at startup. A change to `build-engine`, `ssh-executor` or `deploy.ts` does nothing until it restarts — `bun run dev` uses `node --watch`, which does reload.

## Verifying

Suites live next to the module they cover, named `verify*.ts`, and each declares on its first line what it needs to run:

|  |  |  |
| --- | --- | --- |
| `bun run verify:pure` | nothing | every push, in CI |
| `bun run verify:local` | `bun run dev:stack` | Postgres, Redis, S3 |
| `bun run verify:vm` | `./scripts/spike-local.sh` | a real machine over SSH |

**Infrastructure code is not done when it typechecks.** Anything touching SSH, Swarm, Railpack or Traefik has to run against a real machine before it counts.

## Where things are

| Path                         | Role                              |
| ---------------------------- | --------------------------------- |
| [`CONTEXT.md`](./CONTEXT.md) | domain glossary — read this first |
| [`docs/adr/`](./docs/adr/)   | settled decisions, and why        |
| [`AGENTS.md`](./AGENTS.md)   | code standards                    |
| [`docs/`](./docs/)           | doc map                           |

```
apps/web        dashboard (TanStack Start: UI + server functions)
apps/worker     BullMQ worker — build and deploy jobs
packages/       shared modules: db, ssh-executor, build-engine, …
installer/      install.sh and the production stack
```

## Licence

AGPL-3.0 ([ADR-0014](./docs/adr/0014-agpl-open-core.md)). Every new file is AGPL; contributions must be compatible.
