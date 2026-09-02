import { createContext, use } from "react";
import type { ComponentProps, HTMLAttributes } from "react";

import { Badge } from "@/components/ui/badge";
import { badgeVariant, dotClass } from "@/lib/format";
import type { Tone } from "@/lib/format";
import { cn } from "@/lib/utils";

const StatusToneContext = createContext<Tone>("neutral");

export type StatusProps = Omit<ComponentProps<typeof Badge>, "variant"> & {
  tone: Tone;
};

export function Status({ className, tone, ...props }: StatusProps) {
  return (
    <StatusToneContext value={tone}>
      <Badge
        className={cn("gap-1.5", className)}
        variant={badgeVariant(tone)}
        {...props}
      />
    </StatusToneContext>
  );
}

export type StatusIndicatorProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
};

export function StatusIndicator({
  className,
  tone,
  ...props
}: StatusIndicatorProps) {
  const inherited = use(StatusToneContext);

  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        dotClass(tone ?? inherited),
        className
      )}
      {...props}
    />
  );
}

export type StatusLabelProps = HTMLAttributes<HTMLSpanElement>;

export function StatusLabel({ className, ...props }: StatusLabelProps) {
  return <span className={cn("truncate", className)} {...props} />;
}
