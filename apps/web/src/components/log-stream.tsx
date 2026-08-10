import { useEffect, useMemo, useRef, useState } from "react";
import type { Block, Line, LineKind } from "@/components/log-view";
import { LogView, parse } from "@/components/log-view";

interface LogStreamProps {
  deploymentId: string;
  /** Called when the deployment reaches a terminal status. */
  onEnd?: (status: string) => void;
}

/** Below this, a noise group costs more to collapse than to display. */
const MIN_GROUP = 4;

const ERROR_PATTERN = /\berror\b|\bfailed\b|\bERR!|^✗|\bfatal\b/i;
const STEP_PATTERN = /^[▸✓✗]/;

function classifyBuild(text: string): LineKind {
  if (STEP_PATTERN.test(text)) {
    return ERROR_PATTERN.test(text) ? "error" : "step";
  }
  return ERROR_PATTERN.test(text) ? "error" : "noise";
}

/** Groups sequences of build noise into collapsible blocks. */
function group(lines: Line[]): Block[] {
  const out: Block[] = [];
  let run: Line[] = [];

  const flush = () => {
    if (run.length === 0) {
      return;
    }
    if (run.length >= MIN_GROUP) {
      out.push({ id: run[0]?.id ?? 0, kind: "group", lines: run });
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    if (line.kind === "noise") {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

export function LogStream({ deploymentId, onEnd }: LogStreamProps) {
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

  const blocks = useMemo(() => group(parse(text, classifyBuild)), [text]);

  return (
    <LogView
      blocks={blocks}
      idleLabel="finished"
      live={live}
      placeholder="Waiting for the first line…"
      title="Build logs"
    />
  );
}
