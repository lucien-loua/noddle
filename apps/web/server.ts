import handler from "#start-handler";

import {
  terminalWebsocket,
  tryUpgradeTerminal,
} from "./src/lib/terminal-ws.ts";
import { isTerminalPath } from "./src/lib/terminal.server.ts";
import type { TerminalSocketData } from "./src/lib/terminal.server.ts";

const CLIENT_DIR = `${import.meta.dirname}/dist/client`;
const port = Number(process.env.PORT ?? 3000);

const IMMUTABLE = "public, max-age=31536000, immutable";

async function unwrap(res: Response): Promise<Response> {
  const inner = (res as unknown as { _response?: Promise<Response> })._response;
  return inner ? await inner : res;
}

Bun.serve<TerminalSocketData>({
  async fetch(request: Request, server): Promise<Response | undefined> {
    const { pathname } = new URL(request.url);

    if (isTerminalPath(pathname)) {
      const result = tryUpgradeTerminal(request, server);
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
  idleTimeout: 0,
  port,
  websocket: terminalWebsocket,
});

process.stdout.write(`noddle dashboard on http://0.0.0.0:${port}\n`);
