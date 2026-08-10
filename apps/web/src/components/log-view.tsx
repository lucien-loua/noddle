import type { UIEvent } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { cn } from "@/lib/utils";

/**
 * Cap on displayed lines. A Next.js build produces tens of thousands; the
 * DOM can't hold up, and nobody reads the ten-thousandth one.
 */
export const MAX_LINES = 4000;

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

interface LogViewProps {
  /** The lines already split and classified by the caller. */
  blocks: Block[];
  /** The badge label when the stream is closed. */
  idleLabel: string;
  live: boolean;
  /** What's shown as long as no line has arrived. */
  placeholder: string;
  /** What follows the title on the right — a selector, an action. */
  right?: React.ReactNode;
  title: string;
}

export function LogView({
  blocks,
  idleLabel,
  live,
  placeholder,
  right,
  title,
}: LogViewProps) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const count = blocks.length;
  const label = live ? "live" : idleLabel;

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
    <Frame className="h-full min-h-0" stacked variant="ghost">
      <FrameHeader className="flex-row items-center justify-between gap-3">
        <FrameTitle>{title}</FrameTitle>
        <div className="flex items-center gap-2">
          {right}
          <Badge variant={live ? "secondary" : "outline"}>{label}</Badge>
        </div>
      </FrameHeader>

      {/* Logs FILL the tab. The 320px cap dated from when they unfolded
          under a dashboard row: it prevented pushing the rest of the screen
          down. Since they got their own tab, it does the opposite — 600px
          of empty space under a narrow window, on what is the page's MAIN
          content. */}
      <FramePanel className="flex min-h-0 flex-1 flex-col p-0">
        <div
          className="scroll-fade no-scrollbar wrap-break-word min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed"
          onScroll={handleScroll}
          ref={viewRef}
        >
          {count === 0 ? (
            <span className="text-muted-foreground">{placeholder}</span>
          ) : null}

          {blocks.map((block) =>
            block.kind === "group" ? (
              <details key={block.id}>
                <summary className="cursor-pointer text-muted-foreground">
                  {block.lines.length} build lines
                </summary>
                {block.lines.map((line) => (
                  <div key={line.id}>{line.text}</div>
                ))}
              </details>
            ) : (
              <div
                className={cn(
                  block.kind === "error" && "font-medium text-destructive",
                  block.kind === "step" && "text-foreground"
                )}
                key={block.id}
              >
                {block.text}
              </div>
            )
          )}
        </div>
      </FramePanel>
    </Frame>
  );
}

/** The raw text of a stream, split and classified without grouping. */
export function usePlainBlocks(text: string): Block[] {
  return useMemo(() => parse(text, classifyPlain), [text]);
}
