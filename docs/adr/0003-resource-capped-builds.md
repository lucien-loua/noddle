# Resource-capped builds on a Noddle-owned BuildKit daemon

Every build is resource-capped through a **capped `buildkitd` container Noddle
runs itself**, not via `docker build --memory` (BuildKit accepts and ignores those
flags — a silent no-op, the worst shape, since the build succeeds and the
protection looks active). A Next.js build on a 2 GB VPS will otherwise OOM and
take down running production apps.

**Amended 2026-08-16 (ADR-0020).** The cap used to sit on a builder created by
`docker buildx create --driver docker-container --driver-opt memory=…`. Railpack
talks to BuildKit directly over `BUILDKIT_HOST` and never invokes buildx, so the
daemon is now started by Noddle and both build paths attach to that one container:

- railpack → `BUILDKIT_HOST=docker-container://noddle-buildkit`
- a user's Dockerfile → buildx, `remote` driver pointed at the same container

The cgroup is in the same place it always was — buildx's `docker-container` driver
was itself a `docker run` of `moby/buildkit` with those opts — so only the
mechanism changed, not the decision.

**One daemon on purpose.** Two separately capped daemons would each be entitled to
the full cap, so a Compose build next to an app build could take twice the memory
the server was measured to have. `ensureCappedBuilder` therefore checks the
builder's DRIVER, not merely that it exists: a server provisioned before this
change already has a `noddle-builder` on `docker-container` carrying its own
daemon, and it is removed and recreated.

Verified on a 2 GB Multipass VM: the hog fixture dies at ~640–830 MB against a
1 GB cap, `docker inspect` shows the cgroup on the container, and a service that
was already running answers identically throughout.

**Status:** accepted
