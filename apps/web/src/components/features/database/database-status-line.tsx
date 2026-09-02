import { DATABASE_ENGINE_LABEL } from "@noddle/database-spec";

import { DatabaseMark } from "@/components/features/database/database-mark";
import { StatusIndicator } from "@/components/ui/status";
import type { Tone } from "@/lib/format";
import type { DatabaseRow } from "@/server/databases";

export function DatabaseStatusLine({
  database,
  status,
}: {
  database: DatabaseRow;
  status: { label: string; tone: Tone };
}) {
  const engineLabel = DATABASE_ENGINE_LABEL[database.engine] ?? database.engine;

  return (
    <p className="flex min-w-0 items-center gap-2 truncate text-muted-foreground text-sm">
      <StatusIndicator tone={status.tone} />
      <span className="shrink-0">{status.label}</span>
      <span aria-hidden>·</span>
      <span className="flex shrink-0 items-center gap-1.5">
        <DatabaseMark engine={database.engine} />
        {engineLabel}
      </span>
      <span aria-hidden>·</span>
      <span className="truncate">{database.serverName}</span>
    </p>
  );
}
