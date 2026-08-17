/**
 * Bun WebSocket handlers for interactive terminals.
 *
 * Shared by production `server.ts` and the Bun front in `scripts/dev-web.ts`.
 */
import type { ServerWebSocket } from "bun";

import type { TerminalSocketData } from "@/lib/terminal.server";
import {
  isTerminalPath,
  openTerminalSession,
  parseClientMessage,
  terminalKindFromPath,
} from "@/lib/terminal.server";

export function tryUpgradeTerminal(
  req: Request,
  server: {
    upgrade: (request: Request, options: { data: TerminalSocketData }) => boolean;
  },
): Response | undefined {
  const url = new URL(req.url);
  if (!isTerminalPath(url.pathname)) {
    return;
  }
  const kind = terminalKindFromPath(url.pathname);
  if (!kind) {
    return new Response("not found", { status: 404 });
  }
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    params[k] = v;
  }
  const ok = server.upgrade(req, {
    data: {
      cookie: req.headers.get("cookie"),
      forwardedFor: req.headers.get("x-forwarded-for"),
      kind,
      params,
      userAgent: req.headers.get("user-agent"),
    },
  });
  if (ok) {
    // Bun: must return undefined after a successful upgrade.
    return;
  }
  return new Response("WebSocket upgrade failed", { status: 400 });
}

export const terminalWebsocket = {
  close(ws: ServerWebSocket<TerminalSocketData>) {
    ws.data.session?.close();
    ws.data.ssh?.end();
    ws.data.session = undefined;
    ws.data.ssh = undefined;
  },

  message(ws: ServerWebSocket<TerminalSocketData>, message: string | Buffer) {
    const pty = ws.data.session;
    if (!pty) {
      return;
    }
    const frame = parseClientMessage(message);
    if (frame.type === "resize") {
      pty.resize(frame.cols, frame.rows);
      return;
    }
    if (frame.type === "stdin") {
      pty.write(frame.data);
      return;
    }
    pty.write(frame.data);
  },

  async open(ws: ServerWebSocket<TerminalSocketData>) {
    try {
      const result = await openTerminalSession(ws.data);
      if (!result.ok) {
        ws.send(`\r\n${result.message}\r\n`);
        ws.close(4000 + (result.status % 1000), result.message);
        return;
      }
      ws.data.session = result.pty;
      ws.data.ssh = result.ssh;
      result.pty.onData((chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });
      result.pty.onClose(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, "session ended");
        }
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      try {
        ws.send(`\r\n${msg}\r\n`);
      } catch {
        // already closed
      }
      ws.close(1011, msg);
    }
  },
};
