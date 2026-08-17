import { dotClass, serviceLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The reading order, from most urgent to most mundane — this is the only
 *  thing the display adds to the server's raw count. A status missing
 *  from this list wouldn't be rendered, so it covers all of them. */
const STATUS_ORDER = [
  "crashed",
  "deploying",
  "running",
  "stopped",
  "deleting",
  "created",
] as const;

/**
 * We show ONLY the statuses that are present. "0 crashed" on a healthy
 * installation would permanently occupy space to say nothing, and would
 * dilute exactly the day the number stops being zero.
 */
export function StatusSummary({ counts }: { counts: Record<string, number> }) {
  const shown = STATUS_ORDER.filter((status) => (counts[status] ?? 0) > 0);
  if (shown.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {shown.map((status) => {
        const { label, tone } = serviceLabel(status);
        return (
          <span className="flex items-center gap-1.5 text-sm" key={status}>
            <span
              aria-hidden="true"
              className={cn("size-2 shrink-0 rounded-full", dotClass(tone))}
            />
            <span className="font-medium tabular-nums">{counts[status]}</span>
            <span className="text-muted-foreground">{label.toLowerCase()}</span>
          </span>
        );
      })}
    </div>
  );
}
