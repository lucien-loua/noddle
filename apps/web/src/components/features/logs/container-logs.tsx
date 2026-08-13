/**
 * biome-ignore-all lint/performance/noJsxPropsBind: filter controls;
 * extracting every setState wrapper adds noise without shared children.
 *
 * Runtime container logs — same LogView chrome as build streams (Frame +
 * stream panel), with time range, line limit, level, search, pause and
 * copy. Flat lines. Databases and applications share this: only the SSE
 * path changes.
 */

import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "@/components/copyable-value";
import {
  classifyPlain,
  type Line,
  LogView,
  parse,
} from "@/components/log-view";
import {
  classifyLogLevel,
  type TerminalLogLevel,
} from "@/components/terminal-logs";
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

interface ContainerLogsProps {
  /**
   * Remounts the SSE follow when the container is replaced (start /
   * restart bump `status` or `updatedAt`). Without this the stream stays
   * on the dead container until a full reload.
   */
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

const LEVEL_OPTIONS: Array<{ label: string; value: "all" | TerminalLogLevel }> =
  [
    { label: "All levels", value: "all" },
    { label: "Info", value: "info" },
    { label: "Success", value: "success" },
    { label: "Warning", value: "warning" },
    { label: "Debug", value: "debug" },
    { label: "Error", value: "error" },
  ];

function emptyPlaceholder(
  name: string,
  live: boolean,
  hasText: boolean
): string {
  if (hasText) {
    return "No logs match these filters.";
  }
  if (live) {
    return `Waiting for ${name} to say something…`;
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
  const [live, setLive] = useState(true);
  const [paused, setPaused] = useState(false);
  const [buffer, setBuffer] = useState<string[]>([]);
  const [tail, setTail] = useState("500");
  const [since, setSince] = useState("all");
  const [level, setLevel] = useState<"all" | TerminalLogLevel>("all");
  const [search, setSearch] = useState("");

  const pausedRef = useRef(false as boolean);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    setText("");
    setLive(true);
    setPaused(false);
    pausedRef.current = false;
    setBuffer([]);

    const params = new URLSearchParams({ since, tail });
    // `generation` is a client remount key (status/updatedAt). Unused by
    // the handler; putting it on the URL makes the dependency real.
    params.set("g", generation);
    const separator = streamUrl.includes("?") ? "&" : "?";
    const source = new EventSource(`${streamUrl}${separator}${params}`);

    source.addEventListener("chunk", (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data);
      if (pausedRef.current) {
        setBuffer((previous) => [...previous, payload.data]);
        return;
      }
      setText((previous) => previous + payload.data);
    });

    source.addEventListener("end", () => {
      setLive(false);
      source.close();
    });

    source.onerror = () => {
      setLive(false);
    };

    return () => source.close();
  }, [generation, since, streamUrl, tail]);

  const handlePauseToggle = useCallback(() => {
    setPaused((wasPaused) => {
      if (wasPaused) {
        setBuffer((pending) => {
          if (pending.length > 0) {
            setText((previous) => previous + pending.join(""));
          }
          return [];
        });
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
      placeholder={emptyPlaceholder(name, live, text.length > 0)}
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
            <SelectTrigger className="w-40" size="sm">
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
            <SelectTrigger className="w-36" size="sm">
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
            <SelectTrigger className="w-36" size="sm">
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
            className="h-8 max-w-56"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search logs…"
            value={search}
          />

          <div className="ms-auto flex items-center justify-end">
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
                {paused && buffer.length > 0 ? ` (${buffer.length})` : null}
              </Button>
              <CopyButton label="logs" value={plaintext} />
            </ButtonGroup>
          </div>
        </div>
      }
    />
  );
}
