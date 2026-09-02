import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { relativeTime, relativeTimeLong } from "@/lib/format";

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

export function RelativeTime({
  className,
  iso,
  long = false,
}: {
  className?: string;
  iso: string;
  long?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- Base UI injects the <time> child as the name; the rule only reads literals
          <button
            className="cursor-default rounded-sm text-start focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            type="button"
          />
        }
      >
        <time className={className} dateTime={iso} suppressHydrationWarning>
          {long ? relativeTimeLong(iso) : relativeTime(iso)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{absoluteTime(iso)}</TooltipContent>
    </Tooltip>
  );
}
