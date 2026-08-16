# Worker runs on Node; Bun elsewhere

Bun is the package manager and the runtime for `apps/web`. **`apps/worker` runs on Node** — measured: `dockerode` over an SSH tunnel fails on Bun (`ECONNREFUSED` / hang) while Node passes. `ssh2` itself is fine on Bun; only `dockerode` over the tunnel is affected. Do not "simplify" back to one runtime without re-running `packages/ssh-executor` verifies.

**Status:** accepted
