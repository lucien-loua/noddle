"use client";

import { TerminalIcon } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalDescription,
  FocusModalFooter,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

export type TerminalTarget =
  | { kind: "ssh"; serverId: string; title: string }
  | {
      kind: "container";
      target: "service" | "database";
      id: string;
      title: string;
      shell?: string;
    };

function wsUrl(target: TerminalTarget, cols: number, rows: number): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${window.location.host}`;
  if (target.kind === "ssh") {
    const q = new URLSearchParams({
      cols: String(cols),
      rows: String(rows),
      serverId: target.serverId,
    });
    return `${base}/api/terminal/ssh?${q}`;
  }
  const q = new URLSearchParams({
    cols: String(cols),
    id: target.id,
    rows: String(rows),
    target: target.target,
  });
  if (target.shell) {
    q.set("shell", target.shell);
  }
  return `${base}/api/terminal/container?${q}`;
}

function statusLabel(status: "connecting" | "open" | "closed"): string {
  if (status === "connecting") {
    return "connecting…";
  }
  if (status === "open") {
    return "connected";
  }
  return "disconnected";
}

/**
 * Mounted only while the dialog is open — so the container ref exists when
 * the effect runs. A parent effect keyed on `open` races Base UI's portal:
 * the first paint has no node, the effect bails, and the session never
 * starts (stuck on "connecting…").
 *
 * xterm is loaded dynamically: it's CJS and Vite SSR cannot named-import it.
 */
function TerminalSession({
  onStatus,
  target,
  termRef,
}: {
  onStatus: (status: "connecting" | "open" | "closed") => void;
  target: TerminalTarget;
  /** Host node for Base UI `initialFocus` — xterm focuses its textarea inside. */
  termRef: RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    const host = termRef.current;
    if (!host) {
      return;
    }
    let cancelled = false;
    let dispose: (() => void) | undefined;

    const start = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled) {
        return;
      }

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
        fontSize: 13,
        theme: {
          background: "#0c0c0c",
          cursor: "#e5e5e5",
          foreground: "#e5e5e5",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();

      const { cols, rows } = term;
      const ws = new WebSocket(wsUrl(target, cols, rows));
      ws.binaryType = "arraybuffer";
      onStatus("connecting");

      ws.addEventListener("open", () => {
        onStatus("open");
        term.focus();
      });
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") {
          term.write(ev.data);
          return;
        }
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      });
      ws.addEventListener("close", () => {
        onStatus("closed");
        term.writeln("\r\n\x1b[90mConnection closed.\x1b[0m");
      });
      ws.addEventListener("error", () => {
        onStatus("closed");
      });

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      const onResize = () => {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              cols: term.cols,
              rows: term.rows,
              type: "resize",
            })
          );
        }
      };
      window.addEventListener("resize", onResize);
      const ro = new ResizeObserver(onResize);
      ro.observe(host);

      dispose = () => {
        window.removeEventListener("resize", onResize);
        ro.disconnect();
        ws.close();
        term.dispose();
      };
    };

    start().catch(() => {
      if (!cancelled) {
        onStatus("closed");
      }
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [onStatus, target, termRef]);

  // Padding lives on the shell, not the host: FitAddon sizes to the host,
  // and `scroll-fade-y` on FocusModalBody would mask the last row.
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0c0c0c] p-2">
      <div className="min-h-0 flex-1 overflow-hidden" ref={termRef} />
    </div>
  );
}

export function TerminalDialog({
  onOpenChange,
  onOpenChangeComplete,
  open,
  target,
}: {
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  open: boolean;
  target: TerminalTarget | null;
}) {
  const [status, setStatus] = useState<"connecting" | "open" | "closed">(
    "connecting"
  );
  const termHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setStatus("connecting");
    }
  }, [open]);

  const handleStatus = useCallback((next: "connecting" | "open" | "closed") => {
    setStatus(next);
  }, []);

  const initialFocus = useCallback(
    () =>
      termHostRef.current?.querySelector<HTMLElement>(
        "textarea, .xterm-helper-textarea"
      ) ?? termHostRef.current,
    []
  );

  const title = target ? target.title : "Terminal";
  const kindLabel = target?.kind === "ssh" ? "SSH session" : "Container shell";

  return (
    <FocusModal
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      open={open}
    >
      <FocusModalContent
        className={cn(
          // xterm is a canvas: zoom-out scales the bitmap → soft blurry flash.
          // Keep the fade; pin enter/exit scale to 1.
          "data-closed:[--tw-exit-scale:1] data-open:[--tw-enter-scale:1]"
        )}
        initialFocus={initialFocus}
        overlayProps={{
          className:
            "backdrop-blur-none supports-backdrop-filter:backdrop-blur-none",
        }}
      >
        <FocusModalHeader>
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon className="size-4 shrink-0" weight="bold" />
            <FocusModalTitle className="font-mono text-sm">
              {title}
            </FocusModalTitle>
          </div>
        </FocusModalHeader>
        <FocusModalBody className="mask-none flex min-h-0 flex-col overflow-hidden p-0">
          {/* Keep the session mounted while `target` is set so xterm/WS
              are not torn down mid exit-animation (that flash). */}
          {target ? (
            <TerminalSession
              onStatus={handleStatus}
              target={target}
              termRef={termHostRef}
            />
          ) : null}
        </FocusModalBody>
        <FocusModalFooter className="justify-between">
          <FocusModalDescription
            className={cn(
              "mt-0",
              status === "open" && "text-emerald-600 dark:text-emerald-400",
              status === "connecting" && "text-amber-600 dark:text-amber-400"
            )}
          >
            {kindLabel} · {statusLabel(status)}
          </FocusModalDescription>
          <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <Kbd>Esc</Kbd>
            <span>to close</span>
          </p>
        </FocusModalFooter>
      </FocusModalContent>
    </FocusModal>
  );
}

/** Opens a terminal dialog; renders null until the user clicks. */
export function useTerminalDialog() {
  const [target, setTarget] = useState<TerminalTarget | null>(null);
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
  }, []);

  const handleOpenChangeComplete = useCallback((next: boolean) => {
    if (!next) {
      setTarget(null);
    }
  }, []);

  return {
    openTerminal: (next: TerminalTarget) => {
      setTarget(next);
      setOpen(true);
    },
    terminal: (
      <TerminalDialog
        onOpenChange={handleOpenChange}
        onOpenChangeComplete={handleOpenChangeComplete}
        open={open}
        target={target}
      />
    ),
  };
}
