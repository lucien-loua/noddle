import type { ReactNode } from "react";

import { FramePanel } from "@/components/ui/frame";
import { cn } from "@/lib/utils";

export function ResourceCard({
  actions,
  children,
  onOpen,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  onOpen?: () => void;
  title: ReactNode;
}) {
  return (
    <FramePanel>
      {onOpen ? (
        <button
          aria-hidden
          className="absolute inset-0 z-10 cursor-pointer"
          onClick={onOpen}
          tabIndex={-1}
          type="button"
        />
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <div className="relative z-20 min-w-0 flex-1">
          {onOpen ? (
            <button
              className="flex w-full flex-wrap items-center gap-2 text-left"
              onClick={onOpen}
              type="button"
            >
              {title}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">{title}</div>
          )}
          {children}
        </div>
        {actions ? (
          <div className="relative z-20 flex shrink-0 items-center gap-1">
            {actions}
          </div>
        ) : null}
      </div>
    </FramePanel>
  );
}

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
