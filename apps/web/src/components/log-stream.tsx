import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CopyButton } from "@/components/copyable-value";
import type { Line, LineKind } from "@/components/log-view";
import { LogView, parse } from "@/components/log-view";

interface LogStreamProps {
  deploymentId: string;
  /** Called when the deployment reaches a terminal status. */
  onEnd?: (status: string) => void;
  /** Skip Frame chrome when the stream fills a FocusModal. */
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
  live: boolean;
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
): { live: boolean; text: string } {
  const [text, setText] = useState("");
  const [live, setLive] = useState(true);

  // Kept in a ref: the parent recreates this callback on every render, and
  // putting it in the dependency array would reopen the SSE connection
  // every time.
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    setText("");
    setLive(true);

    const source = new EventSource(`/api/logs/${deploymentId}`);

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
      setLive(false);
      source.close();
      onEndRef.current?.(payload.status);
    });

    source.onerror = () => {
      setLive(false);
    };

    return () => source.close();
  }, [deploymentId]);

  return { live, text };
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
  const { live, text } = useBuildLogSource(deploymentId, onEnd);
  const blocks = useMemo(() => parse(text, classifyBuild), [text]);
  const value = useMemo(() => ({ blocks, live, text }), [blocks, live, text]);

  return <LogStreamContext value={value}>{children}</LogStreamContext>;
}

function LogStreamCopy() {
  const { text } = useLogStream();
  return <CopyButton label="logs" value={text} />;
}

function LogStreamView({ plain }: { plain?: boolean }) {
  const { blocks, live, text } = useLogStream();

  return (
    <LogView
      blocks={blocks}
      idleLabel="finished"
      live={live}
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
