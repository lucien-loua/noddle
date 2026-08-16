import handler from "#start-handler";

import {
  terminalWebsocket,
  tryUpgradeTerminal,
} from "./src/lib/terminal-ws.ts";
import { isTerminalPath } from './src/lib/terminal.server.ts';
import type { TerminalSocketData } from './src/lib/terminal.server.ts';

const CLIENT_DIR = `${import.meta.dirname}/dist/client`;
const port = Number(process.env.PORT ?? 3000);

// Vite fingerprints filenames under /assets/: their content never changes
// without the name changing. Everything else (favicon, robots) can be
// replaced in place, so no immutable caching on those.
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Returns a NATIVE `Response`, whatever the handler actually returned.
 *
 * As soon as a route's module graph reaches `ssh2` — the key generator, the
 * update button — the build bundles srvx's NODE adapter, which replaces
 * `globalThis.Response` with its `NodeResponse` class. `Bun.serve` rejects
 * it: "Expected a Response object, but received NodeResponse", and the
 * server function never renders anything — the client gets Bun's default
 * response, with a misleading 200.
 *
 * Measured on the BUILT server, never visible otherwise: `vite dev` does not
 * go through `Bun.serve`, and neither typecheck nor lint see a type decided
 * at runtime.
 *
 * **The check CANNOT be `instanceof`.** Measured: `r.constructor.name`
 * equals "NodeResponse" and `r instanceof Response` is still `true` — the
 * adapter replaces `globalThis.Response` with its own class, whose
 * `Symbol.hasInstance` answers for both. An `instanceof` guard therefore
 * short-circuits and returns the object unchanged, without reporting
 * anything. We recognize the wrapper by the one thing only it has: its
 * `_response`, which holds the real response.
 *
 * This file is our adapter: this is where the conversion must live, not in
 * every server function.
 */
async function unwrap(res: Response): Promise<Response> {
  const inner = (res as unknown as { _response?: Promise<Response> })._response;
  return inner ? await inner : res;
}

Bun.serve<TerminalSocketData>({
  async fetch(request: Request, server): Promise<Response | undefined> {
    const { pathname } = new URL(request.url);

    if (isTerminalPath(pathname)) {
      const result = tryUpgradeTerminal(request, server);
      // Successful upgrade → undefined (Bun requirement). Failure → Response.
      return result ?? undefined;
    }

    if (pathname !== "/") {
      const file = Bun.file(CLIENT_DIR + pathname);
      if (await file.exists()) {
        return new Response(file, {
          headers: pathname.startsWith("/assets/")
            ? { "Cache-Control": IMMUTABLE }
            : {},
        });
      }
    }

    return unwrap(await handler.fetch(request));
  },
  // A deployment lasts minutes, but the logs' SSE stream stays open the
  // whole time. Without this, Bun closes the connection after 10s of
  // inactivity and the tail reconnects in a loop. Same for terminals.
  idleTimeout: 0,
  port,
  websocket: terminalWebsocket,
});

process.stdout.write(`noddle dashboard on http://0.0.0.0:${port}\n`);
