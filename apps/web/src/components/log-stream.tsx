import { useEffect, useMemo, useRef, useState } from "react";
import type { LineKind } from "@/components/log-view";
import { groupNoise, LogView, parse } from "@/components/log-view";

interface LogStreamProps {
  deploymentId: string;
  /** Called when the deployment reaches a terminal status. */
  onEnd?: (status: string) => void;
}

const ERROR_PATTERN = /\berror\b|\bfailed\b|\bERR!|^✗|\bfatal\b/i;
const STEP_PATTERN = /^[▸✓✗]/;

function classifyBuild(text: string): LineKind {
  if (STEP_PATTERN.test(text)) {
    return ERROR_PATTERN.test(text) ? "error" : "step";
  }
  return ERROR_PATTERN.test(text) ? "error" : "noise";
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

  const blocks = useMemo(() => groupNoise(parse(text, classifyBuild)), [text]);

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
