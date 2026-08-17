import { createContext, use, useMemo } from "react";
import type { ReactNode } from "react";

import { CopyButton } from "@/components/copyable-value";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type TerminalLogLevel =
  | "debug"
  | "error"
  | "info"
  | "success"
  | "warning";

export interface TerminalLogLine {
  id: string;
  /** When omitted, inferred from `text`. */
  level?: TerminalLogLevel;
  text: string;
}

interface LevelStyle {
  badge: string;
  bar: string;
  label: string;
  row: string;
}

const LEVEL_STYLE: Record<TerminalLogLevel, LevelStyle> = {
  debug: {
    badge:
      "border-transparent bg-yellow-600/15 text-yellow-700 dark:text-yellow-400",
    bar: "bg-yellow-500/40",
    label: "debug",
    row: "bg-orange-500/10 hover:bg-orange-500/15",
  },
  error: {
    badge: "border-transparent bg-red-600/15 text-destructive",
    bar: "bg-red-500/40",
    label: "error",
    row: "bg-red-500/10 hover:bg-red-500/15",
  },
  info: {
    badge: "border-transparent bg-blue-600/15 text-blue-700 dark:text-blue-400",
    bar: "bg-blue-600/40",
    label: "info",
    row: "hover:bg-muted/50",
  },
  success: {
    badge:
      "border-transparent bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
    bar: "bg-emerald-500/40",
    label: "success",
    row: "hover:bg-muted/50",
  },
  warning: {
    badge:
      "border-transparent bg-orange-600/15 text-orange-700 dark:text-orange-400",
    bar: "bg-orange-500/40",
    label: "warning",
    row: "bg-yellow-500/10 hover:bg-yellow-500/15",
  },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const ERROR_RE = /❌|\bError:|\bfailed\b|\bfatal\b|\bexception\b|\bcrash\b/i;
const WARNING_RE = /⚠|⚠️|\bwarn(?:ing)?\b|\bdeprecated\b/i;
const SUCCESS_RE =
  /✅|✓|√|\bsuccessfully\b|\bcompleted\b|\bBackup done\b|\bdone\b/i;
const DEBUG_RE = /\[debug\]|(?:^|\s)debug:?\s/i;

/** Matches `date` under UTC — e.g. `[Tue Aug 11 00:31:35 UTC 2026]`. */
export function formatLogStamp(iso: string | Date = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const weekday = WEEKDAYS[d.getUTCDay()] ?? "Mon";
  const month = MONTHS[d.getUTCMonth()] ?? "Jan";
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `[${weekday} ${month} ${day} ${hh}:${mm}:${ss} UTC ${d.getUTCFullYear()}]`;
}

export function classifyLogLevel(message: string): TerminalLogLevel {
  if (ERROR_RE.test(message)) {
    return "error";
  }
  if (WARNING_RE.test(message)) {
    return "warning";
  }
  if (SUCCESS_RE.test(message)) {
    return "success";
  }
  if (DEBUG_RE.test(message)) {
    return "debug";
  }
  return "info";
}

export function parseTerminalLogs(raw: string): TerminalLogLine[] {
  if (raw.length === 0) {
    return [];
  }
  return raw
    .split("\n")
    .map((text) => text.trimEnd())
    .filter((text) => text.length > 0)
    .map((text, index) => ({
      id: String(index),
      level: classifyLogLevel(text),
      text,
    }));
}

interface TerminalLogsContextValue {
  lines: TerminalLogLine[];
  plaintext: string;
}

const TerminalLogsContext = createContext<TerminalLogsContextValue | null>(
  null
);

function useTerminalLogs(): TerminalLogsContextValue {
  const value = use(TerminalLogsContext);
  if (!value) {
    throw new Error("TerminalLogs.* must be used within <TerminalLogs>");
  }
  return value;
}

function toPlaintext(lines: TerminalLogLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

function TerminalLogsRoot({
  children,
  lines,
}: {
  children: ReactNode;
  lines: TerminalLogLine[];
}) {
  const value = useMemo(
    () => ({ lines, plaintext: toPlaintext(lines) }),
    [lines]
  );

  return <TerminalLogsContext value={value}>{children}</TerminalLogsContext>;
}

function TerminalLogsCount() {
  const { lines } = useTerminalLogs();
  const label = lines.length === 1 ? "1 line" : `${lines.length} lines`;
  return <Badge variant="outline">{label}</Badge>;
}

function TerminalLogsCopy({
  className,
  label,
}: {
  className?: string;
  label: string;
}) {
  const { plaintext } = useTerminalLogs();
  return <CopyButton className={className} label={label} value={plaintext} />;
}

function TerminalLogsLine({ line }: { line: TerminalLogLine }) {
  const level = line.level ?? classifyLogLevel(line.text);
  const style = LEVEL_STYLE[level];

  return (
    <div
      className={cn(
        "flex flex-row gap-3 py-1.5 font-mono text-xs sm:py-0.5",
        style.row
      )}
    >
      <div className="flex items-start gap-2">
        <div
          className={cn("w-1.5 shrink-0 self-stretch rounded-[3px]", style.bar)}
        />
        <Badge
          className={cn(
            "h-5 w-14 justify-center px-1 py-0 text-[10px]",
            style.badge
          )}
          variant="outline"
        >
          {style.label}
        </Badge>
      </div>
      <span className="wrap-break-word whitespace-pre-wrap text-foreground">
        {line.text}
      </span>
    </div>
  );
}

function TerminalLogsViewport({
  className,
  placeholder = "No logs yet",
}: {
  className?: string;
  placeholder?: string;
}) {
  const { lines } = useTerminalLogs();

  return (
    <div
      className={cn(
        "scroll-fade no-scrollbar max-h-[min(70vh,720px)] min-h-40 overflow-y-auto rounded-xl border bg-background p-3",
        className
      )}
    >
      {lines.length === 0 ? (
        <span className="text-muted-foreground text-sm">{placeholder}</span>
      ) : (
        lines.map((line) => <TerminalLogsLine key={line.id} line={line} />)
      )}
    </div>
  );
}

export const TerminalLogs = Object.assign(TerminalLogsRoot, {
  Copy: TerminalLogsCopy,
  Count: TerminalLogsCount,
  Line: TerminalLogsLine,
  Viewport: TerminalLogsViewport,
});
