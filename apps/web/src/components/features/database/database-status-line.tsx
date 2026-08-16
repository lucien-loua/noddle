import { DATABASE_ENGINE_LABEL } from "@noddle/database-spec";

import { DatabaseMark } from "@/components/features/database/database-mark";
import type { LifecycleAction } from "@/components/use-lifecycle-actions";
import { dotClass, serviceLabel } from '@/lib/format';
import type { Tone } from '@/lib/format';
import { cn } from "@/lib/utils";
import type { DatabaseRow } from "@/server/databases";

const PENDING_LABEL: Record<LifecycleAction, string> = {
  restart: "Restarting",
  start: "Starting",
  stop: "Stopping",
};

function resolveStatus(
  database: DatabaseRow,
  pendingAction: LifecycleAction | null
): { label: string; tone: Tone } {
  if (pendingAction) {
    return { label: PENDING_LABEL[pendingAction], tone: "busy" };
  }
  return serviceLabel(database.status);
}

export function DatabaseStatusLine({
  database,
  pendingAction,
}: {
  database: DatabaseRow;
  pendingAction: LifecycleAction | null;
}) {
  const status = resolveStatus(database, pendingAction);
  const pending = pendingAction !== null || database.status === "deploying";
  const tone = pending ? "busy" : status.tone;
  const engineLabel = DATABASE_ENGINE_LABEL[database.engine] ?? database.engine;

  return (
    <p className="flex min-w-0 items-center gap-2 truncate text-muted-foreground text-sm">
      <span
        aria-label={status.label}
        className={cn("size-2 shrink-0 rounded-full", dotClass(tone))}
        role="img"
      />
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
