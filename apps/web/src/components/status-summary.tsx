import { StatusIndicator } from "@/components/ui/status";
import { serviceLabel } from "@/lib/format";

const STATUS_ORDER = [
  "crashed",
  "deploying",
  "running",
  "stopped",
  "deleting",
  "created",
] as const;

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
            <StatusIndicator tone={tone} />
            <span className="font-medium tabular-nums">{counts[status]}</span>
            <span className="text-muted-foreground">{label.toLowerCase()}</span>
          </span>
        );
      })}
    </div>
  );
}
