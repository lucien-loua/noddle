"use client";

import { TerminalIcon } from "@phosphor-icons/react";
import "@wterm/dom/src/terminal.css";
import type { TerminalHandle, WTerm } from "@wterm/react";
import {
  lazy,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTheme } from "@/components/theme-provider";
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

/** Deferred so the WASM core is fetched on the first open, not with the route. */
const Terminal = lazy(async () => ({
  default: (await import("@wterm/react")).Terminal,
}));

/**
 * Mounted only while the dialog is open — so the container ref exists when
 * the effect runs. A parent effect keyed on `open` races Base UI's portal:
 * the first paint has no node, the effect bails, and the session never
 * starts (stuck on "connecting…").
 */
function TerminalSession({
  onStatus,
  target,
  termRef,
}: {
  onStatus: (status: "connecting" | "open" | "closed") => void;
  target: TerminalTarget;
  /** Host node for Base UI `initialFocus` — wterm focuses its textarea inside. */
  termRef: RefObject<HTMLDivElement | null>;
}) {
  const { resolvedTheme } = useTheme();
  const handleRef = useRef<TerminalHandle>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ cols: 80, rows: 24 });
  const sentSizeRef = useRef({ cols: 0, rows: 0 });
  const [ready, setReady] = useState(false);

  const sendResize = useCallback(() => {
    const ws = socketRef.current;
    const { cols, rows } = sizeRef.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    if (
      sentSizeRef.current.cols === cols &&
      sentSizeRef.current.rows === rows
    ) {
      return;
    }
    sentSizeRef.current = { cols, rows };
    ws.send(JSON.stringify({ cols, rows, type: "resize" }));
  }, []);

  const handleData = useCallback((data: string) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }, []);

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      sizeRef.current = { cols, rows };
      sendResize();
    },
    [sendResize]
  );

  const handleReady = useCallback((term: WTerm) => {
    sizeRef.current = { cols: term.cols, rows: term.rows };
    setReady(true);
  }, []);

  const handleError = useCallback(() => {
    onStatus("closed");
  }, [onStatus]);

  useEffect(() => {
    const term = handleRef.current;
    if (!(ready && term)) {
      return;
    }

    const { cols, rows } = sizeRef.current;
    const ws = new WebSocket(wsUrl(target, cols, rows));
    ws.binaryType = "arraybuffer";
    socketRef.current = ws;
    sentSizeRef.current = { cols, rows };
    onStatus("connecting");
    let teardown = false;

    ws.addEventListener("open", () => {
      onStatus("open");
      term.focus();
      sendResize();
    });
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        term.write(ev.data);
        return;
      }
      term.write(new Uint8Array(ev.data as ArrayBuffer));
    });
    ws.addEventListener("close", () => {
      if (teardown) {
        return;
      }
      onStatus("closed");
      term.write("\r\n\x1b[90mConnection closed.\x1b[0m\r\n");
    });
    ws.addEventListener("error", () => {
      onStatus("closed");
    });

    return () => {
      teardown = true;
      socketRef.current = null;
      ws.close();
    };
  }, [onStatus, ready, sendResize, target]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={termRef}>
      <Suspense fallback={null}>
        <Terminal
          autoResize
          className="scroll-fade-y no-scrollbar min-h-0 flex-1"
          cursorBlink
          onData={handleData}
          onError={handleError}
          onReady={handleReady}
          onResize={handleResize}
          ref={handleRef}
          theme={resolvedTheme === "light" ? "light" : undefined}
        />
      </Suspense>
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
      termHostRef.current?.querySelector<HTMLElement>("textarea") ??
      termHostRef.current,
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
        initialFocus={initialFocus}
      >
        <FocusModalHeader>
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon className="size-4 shrink-0" />
            <FocusModalTitle className="font-mono text-sm">
              {title}
            </FocusModalTitle>
          </div>
        </FocusModalHeader>
        <FocusModalBody className="mask-none flex min-h-0 flex-col overflow-hidden p-0">
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
