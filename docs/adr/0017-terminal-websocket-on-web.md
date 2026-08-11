# Terminal WebSocket on the dashboard

Interactive shells (SSH on a target server, `docker exec` into a container)
are served as **WebSockets on `apps/web`**, not as BullMQ jobs on the worker.

A terminal is a live bidirectional session: stdin, stdout, resize. The worker
is a one-way job consumer behind Redis. Routing shells through the worker
would invent a second HTTP/WS seam, duplicate SSH credentials resolution, and
still need the browser to talk to something other than the dashboard.

Auth uses the same cookie session as SSE log streams
(`auth.api.getSession({ headers })`). Permissions: `server: shell` (admin+)
for host SSH; `container: shell` (deployer+) for container exec.

In production, terminals ride on the same `Bun.serve` as the dashboard
(`server.ts`). In development, `scripts/dev-web.ts` puts Bun on the public
port and reverse-proxies Vite on loopback — so upgrades use the same
handlers, without a separate terminal companion process.

**Status:** accepted
