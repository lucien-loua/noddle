/**
 * Dev entry: one public Bun.serve (same WebSocket path as production).
 *
 * Vite still does transforms/HMR, but it listens on a loopback port only.
 * Bun owns :3000 — terminal upgrades land here; every other request is
 * reverse-proxied to Vite. HMR uses its own port so it does not compete
 * with Bun's upgrade handler.
 *
 * True Vite `middlewareMode` under Bun.serve is a Connect→Fetch bridge;
 * with TanStack Start that path is fragile. A loopback Vite + Bun front
 * keeps the same public shape as `server.ts` without that risk.
 */
import { join } from "node:path";

import { terminalWebsocket, tryUpgradeTerminal } from "../src/lib/terminal-ws";
import { isTerminalPath } from "../src/lib/terminal.server";
import type { TerminalSocketData } from "../src/lib/terminal.server";

const webRoot = join(import.meta.dir, "..");
const publicPort = Number(process.env.PORT ?? 3000);
const vitePort = Number(process.env.VITE_DEV_PORT ?? 5173);
const hmrPort = Number(process.env.VITE_HMR_PORT ?? 24_678);
const viteOrigin = `http://127.0.0.1:${vitePort}`;

const vite = Bun.spawn(
  [
    "bun",
    "x",
    "vite",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(vitePort),
    "--strictPort",
  ],
  {
    cwd: webRoot,
    env: {
      ...process.env,
      VITE_HMR_PORT: String(hmrPort),
    },
    stderr: "inherit",
    stdout: "inherit",
  }
);

function waitForVite(): Promise<void> {
  const deadline = Date.now() + 60_000;

  const attempt = async (): Promise<void> => {
    if (Date.now() >= deadline) {
      throw new Error(`vite did not become ready on ${viteOrigin}`);
    }
    if (vite.exitCode !== null) {
      throw new Error(`vite exited early with code ${vite.exitCode}`);
    }
    try {
      await fetch(viteOrigin, { method: "HEAD" });
    } catch {
      await Bun.sleep(100);
      return attempt();
    }
  };

  return attempt();
}

function proxyToVite(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, viteOrigin);
  const headers = new Headers(request.headers);
  headers.set("host", `127.0.0.1:${vitePort}`);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

  const init: RequestInit = {
    headers,
    method: request.method,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Required by fetch when streaming a request body.
    (init as { duplex?: string }).duplex = "half";
  }
  // Re-wrap the proxied Response. Returning Vite's Response object as-is
  // can leave SSE bodies (database logs, deploy streams) buffered until the
  // upstream handler settles — live lines never reach the browser. A new
  // Response around the same body stream lets Bun.serve pipe chunks through.
  return fetch(target, init).then(
    (res) =>
      new Response(res.body, {
        headers: res.headers,
        status: res.status,
        statusText: res.statusText,
      })
  );
}

await waitForVite();

const server = Bun.serve<TerminalSocketData>({
  fetch(request, bunServer): Response | Promise<Response> | undefined {
    const { pathname } = new URL(request.url);
    if (isTerminalPath(pathname)) {
      return tryUpgradeTerminal(request, bunServer) ?? undefined;
    }
    return proxyToVite(request);
  },
  idleTimeout: 0,
  port: publicPort,
  websocket: terminalWebsocket,
});

process.stdout.write(
  `noddle dashboard (dev) on http://127.0.0.1:${server.port} → vite :${vitePort}, hmr :${hmrPort}\n`
);

function shutdown() {
  server.stop(true);
  vite.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const viteCode = await vite.exited;
server.stop(true);
process.exit(viteCode === 0 ? 0 : viteCode);
