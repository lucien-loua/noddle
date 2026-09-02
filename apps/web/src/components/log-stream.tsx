import {
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { CopyButton } from "@/components/copyable-value";
import type { Line, LineKind } from "@/components/log-view";
import { LogView, parse } from "@/components/log-view";
import { MAX_RECONNECTS, STREAM_LABEL } from "@/lib/stream-status";
import type { StreamStatus } from "@/lib/stream-status";

interface LogStreamProps {
  deploymentId: string;
  onEnd?: (status: string) => void;
  plain?: boolean;
}

const ERROR_PATTERN = /\berror\b|\bfailed\b|\bERR!|^✗|\bfatal\b/i;
const STEP_PATTERN = /^[▸✓✗]/;

function classifyBuild(text: string): LineKind {
  if (STEP_PATTERN.test(text)) {
    return ERROR_PATTERN.test(text) ? "error" : "step";
  }
  return ERROR_PATTERN.test(text) ? "error" : "noise";
}

interface LogStreamValue {
  blocks: Line[];
  status: StreamStatus;
  text: string;
}

const LogStreamContext = createContext<LogStreamValue | null>(null);

function useLogStream(): LogStreamValue {
  const value = use(LogStreamContext);
  if (!value) {
    throw new Error("LogStream.Copy must be used inside LogStream.Session");
  }
  return value;
}

function useBuildLogSource(
  deploymentId: string,
  onEnd: LogStreamProps["onEnd"]
): { status: StreamStatus; text: string } {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<StreamStatus>("live");

  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    setText("");
    setStatus("live");

    const source = new EventSource(`/api/logs/${deploymentId}`);
    let attempts = 0;

    source.addEventListener("open", () => {
      attempts = 0;
      setStatus("live");
    });

    source.addEventListener("reset", () => setText(""));

    source.addEventListener("chunk", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        data: string;
      };
      setText((previous) => previous + payload.data);
    });

    source.addEventListener("end", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        status: string;
      };
      setStatus("idle");
      source.close();
      onEndRef.current?.(payload.status);
    });

    source.addEventListener("error", () => {
      if (source.readyState === EventSource.CLOSED) {
        setStatus("lost");
        return;
      }
      attempts += 1;
      if (attempts >= MAX_RECONNECTS) {
        source.close();
        setStatus("lost");
        return;
      }
      setStatus("reconnecting");
    });

    return () => source.close();
  }, [deploymentId]);

  return { status, text };
}

function LogStreamSession({
  children,
  deploymentId,
  onEnd,
}: {
  children: ReactNode;
  deploymentId: string;
  onEnd?: (status: string) => void;
}) {
  const { status, text } = useBuildLogSource(deploymentId, onEnd);
  const blocks = useMemo(() => parse(text, classifyBuild), [text]);
  const value = useMemo(
    () => ({ blocks, status, text }),
    [blocks, status, text]
  );

  return <LogStreamContext value={value}>{children}</LogStreamContext>;
}

function LogStreamCopy() {
  const { text } = useLogStream();
  return <CopyButton label="logs" value={text} />;
}

function LogStreamView({ plain }: { plain?: boolean }) {
  const { blocks, status, text } = useLogStream();

  return (
    <LogView
      blocks={blocks}
      idleLabel={STREAM_LABEL[status]}
      live={status === "live"}
      placeholder="Waiting for the first line…"
      plain={plain}
      right={plain ? undefined : <CopyButton label="logs" value={text} />}
      title={plain ? undefined : "Build logs"}
    />
  );
}

export function LogStream({ deploymentId, onEnd, plain }: LogStreamProps) {
  return (
    <LogStreamSession deploymentId={deploymentId} onEnd={onEnd}>
      <LogStreamView plain={plain} />
    </LogStreamSession>
  );
}

LogStream.Session = LogStreamSession;
LogStream.Copy = LogStreamCopy;
LogStream.View = LogStreamView;
