import type { ReactNode } from "react";

import { FramePanel } from "@/components/ui/frame";
import { cn } from "@/lib/utils";

/**
 * One row of a settings list, as a card rather than a table row.
 *
 * The shape the backup schedules established and the rest followed: a
 * heading with its status, a `dl` of facts, actions on the right. A card
 * per object, because each row here IS an object with its own actions —
 * a table earns its place where rows are compared to each other, which is
 * why the audit log, the deployment history and the env var editor keep
 * theirs.
 */
export function ResourceCard({
  actions,
  children,
  onOpen,
  title,
}: {
  actions?: ReactNode;
  /** The facts. Wrap them in `ResourceCardMeta`. */
  children: ReactNode;
  /** Makes the body activate the card — for rows that lead somewhere. */
  onOpen?: () => void;
  title: ReactNode;
}) {
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">{title}</div>
      {children}
    </>
  );

  return (
    <FramePanel>
      <div className="flex items-start justify-between gap-3">
        {onOpen ? (
          <button
            className="min-w-0 flex-1 cursor-pointer text-left"
            onClick={onOpen}
            type="button"
          >
            {body}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{body}</div>
        )}
        {actions ? (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        ) : null}
      </div>
    </FramePanel>
  );
}

/** The `dl` of facts under a card's heading. */
export function ResourceCardMeta({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4",
        className
      )}
    >
      {children}
    </dl>
  );
}

/** One fact. Truncates rather than widening the card. */
export function ResourceCardFact({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate font-medium text-sm">{value}</dd>
    </div>
  );
}
