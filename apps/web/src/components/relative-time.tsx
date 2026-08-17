import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { relativeTime, relativeTimeLong } from "@/lib/format";

/**
 * The exact time, for the tooltip.
 *
 * "3 days ago" answers "is this recent?" and that's the common question;
 * "Aug 14, 2026, 10:59:07 AM" answers "was this before the incident?",
 * which is the question we ask when it matters. Both fit without
 * cluttering, one on hover over the other.
 *
 * A `title` attribute used to carry it. It waits a second, cannot be
 * styled, and never shows on touch — a real tooltip is the same
 * information with none of that.
 */
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
  /** For the rare caller that has to lift it above a stretched link. */
  className?: string;
  iso: string;
  /** "2 days ago" instead of "2d ago", for prose. */
  long?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // `<time>` rather than a `<span>`: the machine-readable value
          // stays in `dateTime` even when the text is approximate.
          // `suppressHydrationWarning` because the text is derived from
          // `Date.now()`, which the server and the browser never agree on.
          <time className={className} dateTime={iso} suppressHydrationWarning />
        }
      >
        {long ? relativeTimeLong(iso) : relativeTime(iso)}
      </TooltipTrigger>
      <TooltipContent>{absoluteTime(iso)}</TooltipContent>
    </Tooltip>
  );
}
