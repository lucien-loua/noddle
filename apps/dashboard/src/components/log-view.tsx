import type { ReactNode, UIEvent } from "react";
import { useCallback, useEffect, useRef } from "react";

import { TerminalLogs } from "@/components/terminal-logs";
import { Badge } from "@/components/ui/badge";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";

export const MAX_LINES = 4000;

const PIN_THRESHOLD_PX = 40;

export type LineKind = "error" | "noise" | "step";

export interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

const ERROR_PATTERN = /\berror\b|\bfailed\b|\bERR!|^✗|\bfatal\b/i;

// oxlint-disable-next-line no-control-regex -- it's precisely ESC that we're targeting
const ANSI = /\u001B\[[0-9;]*m/g;

export function parse(text: string, classify: (line: string) => LineKind) {
  if (text.length === 0) {
    return [];
  }
  const raw = text.split("\n");
  const from = Math.max(0, raw.length - MAX_LINES);
  const lines: Line[] = [];
  for (let i = from; i < raw.length; i += 1) {
    const value = (raw[i] ?? "").replace(ANSI, "");
    lines.push({ id: i, kind: classify(value), text: value });
  }
  return lines;
}

export function classifyPlain(text: string): LineKind {
  return ERROR_PATTERN.test(text) ? "error" : "noise";
}

interface LogViewProps {
  blocks: Line[];
  description?: string;
  idleLabel?: string;
  live?: boolean;
  placeholder: string;
  plain?: boolean;
  right?: ReactNode;
  title?: string;
  toolbar?: ReactNode;
}

function renderLine(line: Line) {
  return (
    <TerminalLogs.Line
      key={line.id}
      line={{ id: String(line.id), text: line.text }}
    />
  );
}

function LogViewHeader({
  description,
  idleLabel,
  live,
  right,
  title,
  toolbar,
}: Pick<
  LogViewProps,
  "description" | "idleLabel" | "live" | "right" | "title" | "toolbar"
>) {
  const showTitleRow = title !== undefined || right !== undefined;
  if (!(showTitleRow || toolbar !== undefined)) {
    return null;
  }

  const label = live ? "live" : (idleLabel ?? "idle");

  return (
    <FrameHeader className={toolbar && showTitleRow ? "gap-3" : undefined}>
      {showTitleRow ? (
        <div className="flex flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <FrameTitle>{title}</FrameTitle> : null}
            {description ? (
              <FrameDescription>{description}</FrameDescription>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {right}
            {title === undefined ? null : (
              <Badge variant={live ? "secondary" : "outline"}>{label}</Badge>
            )}
          </div>
        </div>
      ) : null}
      {toolbar}
    </FrameHeader>
  );
}

function renderBlocks(blocks: Line[], placeholder: string) {
  if (blocks.length === 0) {
    return <span className="text-muted-foreground text-sm">{placeholder}</span>;
  }

  return blocks.map(renderLine);
}

export function LogView({
  blocks,
  description,
  idleLabel,
  live,
  placeholder,
  plain,
  right,
  title,
  toolbar,
}: LogViewProps) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    if (blocks.length === 0 || !pinnedRef.current) {
      return;
    }
    const view = viewRef.current;
    if (view) {
      view.scrollTop = view.scrollHeight;
    }
  }, [blocks]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
  }, []);

  const stream = (
    <div
      className="scroll-fade no-scrollbar min-h-0 flex-1 overflow-y-auto p-4"
      onScroll={handleScroll}
      ref={viewRef}
    >
      {renderBlocks(blocks, placeholder)}
    </div>
  );

  if (plain) {
    return <div className="flex h-full min-h-0 flex-col">{stream}</div>;
  }

  return (
    <Frame className="flex h-full min-h-0 flex-col" stacked variant="ghost">
      <LogViewHeader
        description={description}
        idleLabel={idleLabel}
        live={live}
        right={right}
        title={title}
        toolbar={toolbar}
      />

      <FramePanel className="flex min-h-0 flex-1 flex-col p-0">
        {stream}
      </FramePanel>
    </Frame>
  );
}
