import type { ReactNode, UIEvent } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { TerminalLogs } from "@/components/terminal-logs";
import { Badge } from "@/components/ui/badge";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";

/**
 * Cap on displayed lines. A Next.js build produces tens of thousands; the
 * DOM can't hold up, and nobody reads the ten-thousandth one.
 */
export const MAX_LINES = 4000;

/** Below this, a noise group costs more to collapse than to display. */
export const MIN_NOISE_GROUP = 4;

/** Distance from the bottom below which we consider the user is following along. */
const PIN_THRESHOLD_PX = 40;

export type LineKind = "error" | "noise" | "step";

export interface Line {
  /**
   * The line's rank in the FULL log, not in the displayed window.
   *
   * This is the React key, and an array index wouldn't work: the stream
   * grows from the end while the window is truncated from the start, so a
   * given line's index changes as the build progresses. React would then
   * re-mount lines that haven't moved — across 4000 nodes, while we're
   * reading.
   */
  id: number;
  kind: LineKind;
  text: string;
}

export type Block = Line | { id: number; kind: "group"; lines: Line[] };

const ERROR_PATTERN = /\berror\b|\bfailed\b|\bERR!|^✗|\bfatal\b/i;

/**
 * ANSI color sequences.
 *
 * buildx emits them EVEN under `--progress=plain`: without this cleanup,
 * the dashboard shows "[33m1 warning found" instead of "1 warning found".
 * The cleanup happens here, at render time, not in the log sink: the
 * archive file must remain the exact bytes the VM produced.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: it's precisely ESC that we're targeting
const ANSI = /\u001b\[[0-9;]*m/g;

/** Splits the received text into lines, ANSI stripped, window capped. */
export function parse(text: string, classify: (line: string) => LineKind) {
  // `"".split("\n")` returns `[""]`, i.e. one empty line: without this
  // early return, a stream that has received nothing wouldn't be "empty"
  // and the waiting placeholder would never display.
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

/** The common highlighting rule: an error stands out. */
export function classifyPlain(text: string): LineKind {
  return ERROR_PATTERN.test(text) ? "error" : "noise";
}

/** Groups sequences of noise into collapsible blocks. */
export function groupNoise(lines: Line[]): Block[] {
  const out: Block[] = [];
  let run: Line[] = [];

  const flush = () => {
    if (run.length === 0) {
      return;
    }
    if (run.length >= MIN_NOISE_GROUP) {
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

interface LogViewProps {
  /** The lines already split and classified by the caller. */
  blocks: Block[];
  /** Optional subtitle under the title. */
  description?: string;
  /** The badge label when the stream is closed. Omitted with no `title`. */
  idleLabel?: string;
  live?: boolean;
  /** What's shown as long as no line has arrived. */
  placeholder: string;
  /** What follows the title on the right — a selector, an action. */
  right?: ReactNode;
  /** Frame title. Omit to hide the title row (and live badge). */
  title?: string;
  /** Optional filter row under the title. */
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

export function countLines(blocks: Block[]): number {
  let total = 0;
  for (const block of blocks) {
    total += block.kind === "group" ? block.lines.length : 1;
  }
  return total;
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

function renderBlocks(blocks: Block[], placeholder: string) {
  if (blocks.length === 0) {
    return <span className="text-muted-foreground text-sm">{placeholder}</span>;
  }

  return blocks.map((block) =>
    block.kind === "group" ? (
      <details key={block.id}>
        <summary className="cursor-pointer py-1 text-muted-foreground text-xs">
          {block.lines.length} build lines
        </summary>
        {block.lines.map(renderLine)}
      </details>
    ) : (
      renderLine(block)
    )
  );
}

export function LogView({
  blocks,
  description,
  idleLabel,
  live,
  placeholder,
  right,
  title,
  toolbar,
}
: LogViewProps)
{
  const viewRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // The dependency is on `blocks`, not on their COUNT: a chunk that
  // extends the last line without opening a new one leaves the count
  // unchanged, and the stream would stop following the bottom for as long
  // as a long line is being written. `blocks` is memoized on the text, so
  // it changes exactly when there's something to re-scroll to.
  useEffect(() => {
    if (blocks.length === 0 || !pinnedRef.current) {
      return;
    }
    const view = viewRef.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive on useRef
    if (view) {
      view.scrollTop = view.scrollHeight;
    }
  }, [blocks]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
  }, []);

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

      {/* TWO elements: `scroll-fade` is a mask-image — it eats the
          background and radius of whatever carries it. The FramePanel
          keeps the border; only the scrolling body is masked. */}
      <FramePanel className="flex min-h-0 flex-1 flex-col p-0">
        <div
          className="scroll-fade no-scrollbar min-h-0 flex-1 overflow-y-auto p-3"
        onScroll={handleScroll}
         ref={viewRef}
        >
          {renderBlocks(blocks, placeholder)}
        </div>
      </FramePanel>
    </Frame>
  );
}

/** The raw text of a stream, split and classified without grouping. */
export function usePlainBlocks(text: string): Block[] {
  return useMemo(() => parse(text, classifyPlain), [text]);
}
