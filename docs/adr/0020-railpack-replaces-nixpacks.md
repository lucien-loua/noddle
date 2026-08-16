# Railpack replaces Nixpacks

Zero-config builds use **Railpack**, not Nixpacks. Nixpacks went into maintenance
mode upstream and Railway names Railpack its successor; Railpack is MIT, so
ADR-0014 is unaffected.

Railpack does **not** generate a Dockerfile — it builds the LLB graph and hands it
to BuildKit over `BUILDKIT_HOST`. Consequences, all measured on a 2 GB VM:

- The image reaches the daemon because Railpack pipes BuildKit's `ExporterDocker`
  tarball into a bare `docker load`. That binary name is hardcoded, so the whole
  invocation runs under `sudo -E` — `-E` is load-bearing, it carries
  `BUILDKIT_HOST`. `--output` is **not** this path: it exports a filesystem.
- There is no registry-push exporter. The embedded registry keeps its existing
  `docker push` step, unchanged.
- A user's own Dockerfile still builds through buildx, so Noddle carries **two**
  build front-ends. They share one capped daemon — see ADR-0003.

What this buys, each a rule that no longer exists:

| Nixpacks | Railpack |
|---|---|
| `--apt`/`--pkgs` wipe the nix overlays; no way to inject a package via the CLI | `RAILPACK_BUILD_APT_PACKAGES` / `RAILPACK_DEPLOY_APT_PACKAGES`, `"..."` extends the generated list |
| defaults to Node 18, removed from nixpkgs as EOL — a silent repo does not build | resolves 24.18.1 for a silent repo; `FALLBACK_NODE_VERSION` deleted |

The cost, and it is the one to remember: **the base image inverted.** Measured
under the non-login `sh -c` a HEALTHCHECK runs in, Railpack's Debian 12 base has
**no curl and no wget**, while `node` IS on PATH via `/mise/shims` — the exact
opposite of `nixpacks:ubuntu`. The deploy healthcheck is a curl probe, so
`build-engine` forces `curl` into every image Noddle builds from source. Guarded
by `verify-build-dir`. Without it no task converges and it reads as a Traefik
routing bug.

`build_method` was renamed `nixpacks` → `railpack` in place
(`ALTER TYPE ... RENAME VALUE`). Naming the enum after the vendor is what made
this a data migration at all; a builder-neutral value is worth considering the
next time it moves, not now.

**Status:** accepted
