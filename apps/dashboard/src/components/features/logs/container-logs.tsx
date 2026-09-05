import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CopyButton } from "@/components/copyable-value";
import { classifyPlain, LogView, parse } from "@/components/log-view";
import type { Line } from "@/components/log-view";
import { classifyLogLevel } from "@/components/terminal-logs";
import type { TerminalLogLevel } from "@/components/terminal-logs";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import { MAX_RECONNECTS, STREAM_LABEL, STREAM_TONE } from "@/lib/stream-status";
import type { StreamStatus } from "@/lib/stream-status";

interface ContainerLogsProps {
  generation: string;
  name: string;
  streamUrl: string;
}

const LINE_OPTIONS = [
  { label: "100 lines", value: "100" },
  { label: "300 lines", value: "300" },
  { label: "500 lines", value: "500" },
  { label: "1000 lines", value: "1000" },
  { label: "5000 lines", value: "5000" },
] as const;

const SINCE_OPTIONS = [
  { label: "All time", value: "all" },
  { label: "Last hour", value: "1h" },
  { label: "Last 6 hours", value: "6h" },
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "168h" },
  { label: "Last 30 days", value: "720h" },
] as const;

const LEVEL_OPTIONS: { label: string; value: "all" | TerminalLogLevel }[] = [
  { label: "All levels", value: "all" },
  { label: "Info", value: "info" },
  { label: "Success", value: "success" },
  { label: "Warning", value: "warning" },
  { label: "Debug", value: "debug" },
  { label: "Error", value: "error" },
];

function emptyPlaceholder(
  name: string,
  status: StreamStatus,
  hasText: boolean
): string {
  if (hasText) {
    return "No logs match these filters.";
  }
  if (status === "live") {
    return `Waiting for ${name} to say something…`;
  }
  if (status === "reconnecting") {
    return "Reconnecting…";
  }
  if (status === "lost") {
    return "Connection lost.";
  }
  return "No logs yet.";
}

function filterLines(
  lines: Line[],
  level: "all" | TerminalLogLevel,
  search: string
): Line[] {
  let next = lines;
  if (level !== "all") {
    next = next.filter((line) => classifyLogLevel(line.text) === level);
  }
  const needle = search.trim().toLowerCase();
  if (needle.length > 0) {
    next = next.filter((line) => line.text.toLowerCase().includes(needle));
  }
  return next;
}

export function ContainerLogs({
  generation,
  name,
  streamUrl,
}: ContainerLogsProps) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<StreamStatus>("live");
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [tail, setTail] = useState("500");
  const [since, setSince] = useState("all");
  const [level, setLevel] = useState<"all" | TerminalLogLevel>("all");
  const [search, setSearch] = useState("");

  const pausedRef = useRef(false as boolean);
  const pendingRef = useRef<string[]>([]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    setText("");
    setStatus("live");
    setPaused(false);
    pausedRef.current = false;
    pendingRef.current = [];
    setPendingCount(0);

    const params = new URLSearchParams({ since, tail });
    params.set("g", generation);
    const separator = streamUrl.includes("?") ? "&" : "?";
    const source = new EventSource(`${streamUrl}${separator}${params}`);
    let attempts = 0;

    source.addEventListener("open", () => {
      attempts = 0;
      setStatus("live");
    });

    source.addEventListener("reset", () => {
      pendingRef.current = [];
      setPendingCount(0);
      setText("");
    });

    source.addEventListener("chunk", (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data);
      if (pausedRef.current) {
        pendingRef.current.push(payload.data);
        setPendingCount(pendingRef.current.length);
        return;
      }
      setText((previous) => previous + payload.data);
    });

    source.addEventListener("end", () => {
      setStatus("idle");
      source.close();
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
  }, [generation, since, streamUrl, tail]);

  const handlePauseToggle = useCallback(() => {
    setPaused((wasPaused) => {
      if (wasPaused) {
        const pending = pendingRef.current;
        pendingRef.current = [];
        setPendingCount(0);
        if (pending.length > 0) {
          setText((previous) => previous + pending.join(""));
        }
      }
      return !wasPaused;
    });
  }, []);

  const blocks = useMemo(
    () => filterLines(parse(text, classifyPlain), level, search),
    [level, search, text]
  );

  const plaintext = useMemo(
    () => blocks.map((line) => line.text).join("\n"),
    [blocks]
  );

  return (
    <LogView
      blocks={blocks}
      placeholder={emptyPlaceholder(name, status, text.length > 0)}
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            onValueChange={(value) => {
              if (typeof value === "string") {
                setSince(value);
              }
            }}
            value={since}
          >
            <SelectTrigger aria-label="Time range" className="w-40" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {SINCE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select
            onValueChange={(value) => {
              if (typeof value === "string") {
                setTail(value);
              }
            }}
            value={tail}
          >
            <SelectTrigger aria-label="Line count" className="w-36" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LINE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select
            onValueChange={(value) => {
              if (typeof value === "string") {
                setLevel(value);
              }
            }}
            value={level}
          >
            <SelectTrigger aria-label="Log level" className="w-36" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LEVEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <Input
            aria-label="Search logs"
            className="h-8 max-w-56"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search logs…"
            value={search}
          />

          <div className="ms-auto flex items-center justify-end gap-2">
            {status === "live" ? null : (
              <Status tone={STREAM_TONE[status]}>
                <StatusIndicator />
                <StatusLabel>{STREAM_LABEL[status]}</StatusLabel>
              </Status>
            )}
            <ButtonGroup>
              <ButtonGroupText>
                {blocks.length === 1 ? "1 line" : `${blocks.length} lines`}
              </ButtonGroupText>
              <Button onClick={handlePauseToggle} size="sm" variant="outline">
                {paused ? (
                  <PlayIcon weight="fill" />
                ) : (
                  <PauseIcon weight="fill" />
                )}
                {paused ? "Resume" : "Pause"}
                {paused && pendingCount > 0 ? ` (${pendingCount})` : null}
              </Button>
              <CopyButton label="logs" value={plaintext} />
            </ButtonGroup>
          </div>
        </div>
      }
    />
  );
}
