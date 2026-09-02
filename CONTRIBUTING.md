# Contributing to Noddle

Issues and pull requests are welcome, including ones that only ask a question. This file is the fuller version of the README's Contributing section — read that first if you haven't.

## Before you write any code

Three documents carry context the code itself doesn't:

|  |  |
| --- | --- |
| [`CONTEXT.md`](./CONTEXT.md) | the domain glossary — what a Service, a Deployment, a Job mean here |
| [`AGENTS.md`](./AGENTS.md) | code standards |
| [`.claude/CLAUDE.md`](./.claude/CLAUDE.md) | settled decisions, each with what it cost to learn |

If a rule in `CLAUDE.md` looks wrong or arbitrary, it almost always has a measurement behind it — check there before assuming it's an oversight. If you still disagree after reading it, open an issue with the measurement you'd want to see change it.

## Setting up

```bash
bun install
bun run dev
```

This seeds `apps/*/.env`, brings up Postgres/Redis/S3 in Docker, applies migrations, and starts the dashboard and worker together on <http://127.0.0.1:3000>. Deploying something needs a target server, which local development gets from a Multipass VM:

```bash
./scripts/spike-local.sh     # provision the VM, run the deploy chain on it
./scripts/adopt-local.sh     # register it as target server #1
```

`apps/web` runs on Bun, `apps/worker` on Node — see the README for why. The worker loads its code once at startup; `bun run dev` uses `node --watch`, which reloads it.

## Making a change

Fork the repository, branch off `main`, and open a pull request against `main` when it's ready. Small, focused pull requests are easier to review than large ones — one concern per PR, same as one concern per commit.

**Commit messages carry the why.** There are no comments in this codebase — the reasoning goes in the commit message instead, where `git log -S` can find it later. A message like "fix bug" or "update component" won't be accepted; say what broke, what you measured, or what the alternative was and why you didn't take it.

## Before opening a pull request

```bash
bun run check       # oxlint + oxfmt, via Ultracite
bun run typecheck
bun run verify:pure
```

If your change touches SSH, Swarm, Railpack, Traefik, or anything else that talks to real infrastructure, it isn't done when it typechecks. Run it against a real machine:

```bash
bun run verify:local   # needs `bun run dev:stack` — Postgres, Redis, S3
bun run verify:vm      # needs ./scripts/spike-local.sh — a real machine over SSH
```

If you can't run the VM tier yourself, say so plainly in the pull request rather than implying it works. That's a normal thing to say here, not a failure — a reviewer would rather know than find out later.

## What helps a change land

- One concern per commit, with the _why_ in the message
- New vocabulary added to `CONTEXT.md` in the same change that introduces it
- A `verify*.ts` alongside anything that could regress silently — see how existing ones declare what they need on their first line
- For infrastructure changes, what you actually ran it against

## What gets pushed back

- A new dependency without a reason it's needed
- Config options, env vars, or feature flags nobody asked for
- Files scaffolded for a later phase that isn't being worked on
- Comments — put the reasoning in the commit message instead

## Licence

Noddle is Apache-2.0. By submitting a pull request, you agree your contribution is licensed under the same terms — no separate CLA to sign.
